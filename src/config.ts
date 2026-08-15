import "dotenv/config";

export type DatabaseDriver = "sqlite" | "mysql";

export type AppConfig = {
  host: string;
  port: number;
  databaseDriver: DatabaseDriver;
  sqlitePath: string;
  mysqlUrl?: string;
  userOne: { username: string; name: string; passwordHash: string };
  userTwo: { username: string; name: string; passwordHash: string };
  sessionSecret: string;
  contentEncryptionKey: string;
  secureCookies: boolean;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error("COOKIE_SECURE must be true or false");
}

export function loadConfig(): AppConfig {
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");

  const databaseDriver = (process.env.DATABASE_DRIVER ?? "sqlite") as DatabaseDriver;
  if (databaseDriver !== "sqlite" && databaseDriver !== "mysql") {
    throw new Error("DATABASE_DRIVER must be sqlite or mysql");
  }

  const mysqlUrl = process.env.MYSQL_URL?.trim();
  if (databaseDriver === "mysql" && !mysqlUrl) throw new Error("MYSQL_URL is required when DATABASE_DRIVER=mysql");

  const userOneUsername = process.env.USER_ONE_USERNAME?.trim() || "starlight";
  const userTwoUsername = process.env.USER_TWO_USERNAME?.trim() || "moonlight";
  if (userOneUsername === userTwoUsername) throw new Error("The two usernames must be different");

  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  const contentEncryptionKey = required("CONTENT_ENCRYPTION_KEY");
  if (Buffer.from(contentEncryptionKey, "base64").length !== 32) {
    throw new Error("CONTENT_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  return {
    host: process.env.HOST?.trim() || "0.0.0.0",
    port,
    databaseDriver,
    sqlitePath: process.env.SQLITE_PATH?.trim() || "./data/secret-space.db",
    mysqlUrl,
    userOne: {
      username: userOneUsername,
      name: process.env.USER_ONE_NAME?.trim() || "星星",
      passwordHash: required("USER_ONE_PASSWORD_HASH"),
    },
    userTwo: {
      username: userTwoUsername,
      name: process.env.USER_TWO_NAME?.trim() || "月亮",
      passwordHash: required("USER_TWO_PASSWORD_HASH"),
    },
    sessionSecret,
    contentEncryptionKey,
    secureCookies: booleanValue(process.env.COOKIE_SECURE, process.env.NODE_ENV === "production"),
  };
}
