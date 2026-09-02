/**
 * Betaflight firmware-presets (github.com/betaflight/firmware-presets) are
 * CLI snippets with a small directive language on top: `#$ INCLUDE: <path>`
 * pulls in another preset, and `#$ OPTION BEGIN (CHECKED|UNCHECKED): <name>`
 * … `#$ OPTION END` wraps optional blocks the pilot ticks in Configurator.
 *
 * To turn a preset into a plain CLI dump (for parseCliDump / seeding) we
 * inline the includes we have and keep only the options that are checked by
 * default — the same result Configurator would apply when the preset is
 * accepted as-is.
 */

const INCLUDE_RE = /^#\$\s*INCLUDE:\s*(\S+)/i;
const OPTION_BEGIN_RE = /^#\$\s*OPTION BEGIN\s*\((CHECKED|UNCHECKED)\)/i;
const OPTION_END_RE = /^#\$\s*OPTION END/i;

export interface PresetResolveOptions {
  /** include path (e.g. "presets/4.5/tune/defaults.txt") → preset text */
  includes?: Record<string, string>;
  /** keep UNCHECKED options too (default false) */
  keepUnchecked?: boolean;
}

/** Metadata lines (`#$ KEY: value`) of a preset, first value per key. */
export function presetMeta(text: string): Record<string, string> {
  const meta: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const m = /^#\$\s*([A-Z_]+):\s*(.*)$/.exec(raw.trim());
    if (m && !(m[1]! in meta)) meta[m[1]!] = m[2]!.trim();
  }
  return meta;
}

/**
 * Flatten a preset into plain CLI lines: resolve includes (recursively, with
 * a cycle guard), drop unchecked option blocks, strip directives.
 */
export function resolvePreset(text: string, opts: PresetResolveOptions = {}, seen: Set<string> = new Set()): string {
  const out: string[] = [];
  let skipping = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const begin = OPTION_BEGIN_RE.exec(line);
    if (begin) {
      skipping = begin[1]!.toUpperCase() === "UNCHECKED" && !opts.keepUnchecked;
      continue;
    }
    if (OPTION_END_RE.test(line)) {
      skipping = false;
      continue;
    }
    if (skipping) continue;
    const inc = INCLUDE_RE.exec(line);
    if (inc) {
      const path = inc[1]!;
      const included = opts.includes?.[path];
      if (included && !seen.has(path)) {
        seen.add(path);
        out.push(`# included: ${path}`);
        out.push(resolvePreset(included, opts, seen));
      } else {
        out.push(`# include not resolved: ${path}`);
      }
      continue;
    }
    if (line.startsWith("#$")) continue; // other directives (TITLE, DESCRIPTION, OPTION_GROUP …)
    out.push(raw);
  }
  return out.join("\n");
}
