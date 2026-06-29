/**
 * Exit handler
 * This handler is used to exit the CLI with a status code
 */

export function exit(): never {
  process.exit(0);
}

export function exitWithError(message: string, code: number = 1): never {
  console.error(message);
  process.exit(code);
}

export function cliError(message: string): never {
  console.error(message);
  process.exit(1);
}

export function cliOk(message?: string): never {
  if (message) {
    console.log(message);
  }
  process.exit(0);
}