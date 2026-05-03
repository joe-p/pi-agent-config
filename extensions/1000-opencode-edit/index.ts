import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import {
  replace,
  trimDiff,
  readFile,
  writeWithDirs,
  normalizeLineEndings,
  detectLineEnding,
  convertToLineEnding,
} from "./replace";
import { readFileSync } from "node:fs";

const DESC = readFileSync(path.join(__dirname, "description.md"), "utf-8");

async function createTwoFilesPatch(
  oldFileName: string,
  newFileName: string,
  oldContent: string,
  newContent: string,
): Promise<string> {
  // Simple unified diff generator
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let diff = `--- ${oldFileName}\n+++ ${newFileName}\n`;

  // Find changes (simplified - just show the whole file as changed)
  // A proper diff algorithm would be much more complex
  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      // Lines match
      diff += ` ${oldLines[i]}\n`;
      i++;
      j++;
    } else {
      // Look for changes
      const oldLine = i < oldLines.length ? oldLines[i] : undefined;
      const newLine = j < newLines.length ? newLines[j] : undefined;

      if (oldLine !== undefined) {
        diff += `-${oldLine}\n`;
        i++;
      }
      if (newLine !== undefined) {
        diff += `+${newLine}\n`;
        j++;
      }
    }
  }

  return diff;
}

async function diffLines(oldContent: string, newContent: string) {
  const result: Array<{
    added?: boolean;
    removed?: boolean;
    value: string;
    count?: number;
  }> = [];
  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  let i = 0;
  let j = 0;

  while (i < oldLines.length || j < newLines.length) {
    if (
      i < oldLines.length &&
      j < newLines.length &&
      oldLines[i] === newLines[j]
    ) {
      result.push({ value: oldLines[i]!, count: 1 });
      i++;
      j++;
    } else {
      if (i < oldLines.length) {
        result.push({ removed: true, value: oldLines[i]!, count: 1 });
        i++;
      }
      if (j < newLines.length) {
        result.push({ added: true, value: newLines[j]!, count: 1 });
        j++;
      }
    }
  }

  return result;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "edit",
    label: "Edit",
    description: DESC,
    parameters: Type.Object({
      path: Type.String({
        description: "The absolute path to the file to modify",
      }),
      oldString: Type.String({ description: "The text to replace" }),
      newString: Type.String({
        description:
          "The text to replace it with (must be different from oldString)",
      }),
      replaceAll: Type.Optional(
        Type.Boolean({
          description: "Replace all occurrences of oldString (default false)",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        path: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      },
      _signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      try {
        if (!params.path) {
          throw new Error("path is required");
        }

        if (params.oldString === params.newString) {
          throw new Error(
            "No changes to apply: oldString and newString are identical.",
          );
        }

        const filePath = path.isAbsolute(params.path)
          ? params.path
          : path.join(ctx.cwd, params.path);

        let diff = "";
        let contentOld = "";
        let contentNew = "";

        if (params.oldString === "") {
          // Creating a new file or appending content
          let existed = false;
          try {
            await fs.access(filePath);
            existed = true;
          } catch {
            // File doesn't exist
          }

          const source = existed
            ? await readFile(filePath)
            : { bom: false, text: "" };
          contentOld = source.text;
          contentNew = params.newString;
          diff = trimDiff(
            await createTwoFilesPatch(
              filePath,
              filePath,
              contentOld,
              contentNew,
            ),
          );

          await writeWithDirs(filePath, contentNew);
        } else {
          // Replacing existing content
          let fileStats;
          try {
            fileStats = await fs.stat(filePath);
          } catch {
            throw new Error(`File ${filePath} not found`);
          }

          if (fileStats.isDirectory()) {
            throw new Error(`Path is a directory, not a file: ${filePath}`);
          }

          const source = await readFile(filePath);
          contentOld = source.text;

          const ending = detectLineEnding(contentOld);
          const old = convertToLineEnding(
            normalizeLineEndings(params.oldString),
            ending,
          );
          const replacement = convertToLineEnding(
            normalizeLineEndings(params.newString),
            ending,
          );

          contentNew = replace(
            contentOld,
            old,
            replacement,
            params.replaceAll ?? false,
          );

          diff = trimDiff(
            await createTwoFilesPatch(
              filePath,
              filePath,
              normalizeLineEndings(contentOld),
              normalizeLineEndings(contentNew),
            ),
          );

          await writeWithDirs(filePath, contentNew);

          // Recalculate diff after write (in case line endings change)
          diff = trimDiff(
            await createTwoFilesPatch(
              filePath,
              filePath,
              normalizeLineEndings(contentOld),
              normalizeLineEndings(contentNew),
            ),
          );
        }

        // Calculate additions and deletions
        let additions = 0;
        let deletions = 0;
        const changes = await diffLines(contentOld, contentNew);
        for (const change of changes) {
          if (change.added) additions += change.count || 0;
          if (change.removed) deletions += change.count || 0;
        }

        const filediff = {
          file: filePath,
          patch: diff,
          additions,
          deletions,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: `Edit applied successfully.\n\nFile: ${path.relative(ctx.cwd, filePath)}\n+${additions} -${deletions}`,
            },
          ],
          details: {
            diff,
            filediff,
          },
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${errorMessage}`,
            },
          ],
          details: {},
          isError: true,
        };
      }
    },
  });
}
