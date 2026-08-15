import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const target = new URL("../.env", import.meta.url);
const prompt = createInterface({ input, output });

function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 210_000, 32, "sha256");
  return `pbkdf2$210000$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

async function ask(label, fallback = "") {
  const suffix = fallback ? ` (${fallback})` : "";
  const value = (await prompt.question(`${label}${suffix}: `)).trim();
  return value || fallback;
}

async function askRequired(label) {
  while (true) {
    const value = await ask(label);
    if (value) return value;
    output.write("此项不能为空。\n");
  }
}

try {
  if (existsSync(target)) {
    const overwrite = (await ask(".env 已存在，是否覆盖？输入 yes 继续", "no")).toLowerCase();
    if (overwrite !== "yes") process.exit(0);
  }

  output.write("密码只会用于生成哈希，不会写入文件；输入时终端会显示明文。\n\n");
  const userOneUsername = await ask("你的登录账号", "starlight");
  const userOneName = await ask("你的显示名称", "星星");
  const userOnePassword = await askRequired("你的登录密码");
  const userTwoUsername = await ask("爱人的登录账号", "moonlight");
  const userTwoName = await ask("爱人的显示名称", "月亮");
  const userTwoPassword = await askRequired("爱人的登录密码");

  const variables = {
    NODE_ENV: "development",
    HOST: "0.0.0.0",
    PORT: "3000",
    COOKIE_SECURE: "false",
    DATABASE_DRIVER: "sqlite",
    SQLITE_PATH: "./data/secret-space.db",
    USER_ONE_USERNAME: userOneUsername,
    USER_ONE_NAME: userOneName,
    USER_ONE_PASSWORD_HASH: passwordHash(userOnePassword),
    USER_TWO_USERNAME: userTwoUsername,
    USER_TWO_NAME: userTwoName,
    USER_TWO_PASSWORD_HASH: passwordHash(userTwoPassword),
    SESSION_SECRET: randomBytes(32).toString("base64"),
    CONTENT_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  };
  const content = Object.entries(variables).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n") + "\n";
  await writeFile(target, content, { encoding: "utf8", mode: 0o600 });
  output.write("\n已生成 .env。运行 npm run dev 即可启动。\n");
} finally {
  prompt.close();
}
