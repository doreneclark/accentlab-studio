import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import {
  InsertUser,
  huggingFaceGenerationLeases,
  users,
} from "../drizzle/schema";
import { ENV } from "./_core/env";

export interface HuggingFaceLeaseRecord {
  state: "idle" | "active" | "pausing";
  generationId: string;
  expiresAt: number;
}

export interface HuggingFaceLeaseAccess {
  get(): HuggingFaceLeaseRecord;
  save(record: HuggingFaceLeaseRecord): Promise<void>;
}

export type HuggingFaceLeaseLock = <T>(
  ownerEmail: string,
  operation: (lease: HuggingFaceLeaseAccess) => Promise<T>
) => Promise<T>;

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      _db = drizzle(process.env.DATABASE_URL);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

export const withHuggingFaceLeaseLock: HuggingFaceLeaseLock = async (
  ownerEmail,
  operation
) => {
  const db = await getDb();
  if (!db) throw new Error("Shared database is unavailable.");
  return db.transaction(async tx => {
    await tx
      .insert(huggingFaceGenerationLeases)
      .values({
        ownerEmail,
        state: "idle",
        generationId: "",
        expiresAt: new Date(0),
      })
      .onDuplicateKeyUpdate({ set: { ownerEmail } });
    const rows = await tx
      .select()
      .from(huggingFaceGenerationLeases)
      .where(eq(huggingFaceGenerationLeases.ownerEmail, ownerEmail))
      .for("update")
      .limit(1);
    const row = rows[0];
    if (!row) throw new Error("HF generation lease row is unavailable.");
    let current: HuggingFaceLeaseRecord = {
      state: row.state,
      generationId: row.generationId,
      expiresAt: row.expiresAt.getTime(),
    };
    return operation({
      get: () => ({ ...current }),
      save: async record => {
        await tx
          .update(huggingFaceGenerationLeases)
          .set({
            state: record.state,
            generationId: record.generationId,
            expiresAt: new Date(record.expiresAt),
          })
          .where(eq(huggingFaceGenerationLeases.ownerEmail, ownerEmail));
        current = { ...record };
      },
    });
  });
};

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    throw new Error("Database is not available");
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

// TODO: add feature queries here as your schema grows.
