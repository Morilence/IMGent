export type CommandCapability = "offline" | "online" | "dual";

export const COMMAND_CAPABILITIES = {
  init: "offline",
  "profile add": "offline",
  "bot add": "offline",
  "bot authorize": "offline",
  "skills init": "offline",
  restore: "offline",
  pair: "online",
  "group authorize": "online",
  doctor: "dual",
  status: "dual",
  "identity list": "dual",
  "group list": "dual",
  "skills list": "dual",
  "skills validate": "dual",
  backup: "dual",
} as const satisfies Record<string, CommandCapability>;

export type CommandName = keyof typeof COMMAND_CAPABILITIES;
