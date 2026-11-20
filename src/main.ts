import { realpathSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * True when Node was started with the file named `name` (without extension)
 * and that file is the module at `metaUrl`. Paths are resolved first, because
 * a package's command is a symbolic link. The name is checked because these
 * modules are also bundled into the one command, where they must not start
 * on their own.
 */
export function isMain(metaUrl: string, name: string): boolean {
  const started = process.argv[1];
  if (!started) return false;
  try {
    const self = realpathSync(fileURLToPath(metaUrl));
    return realpathSync(started) === self && basename(self).replace(/\.[jt]s$/, "") === name;
  } catch {
    return false;
  }
}
