// A LiquidJS engine that renders our TRMNL plugin templates *outside* trmnlp,
// so tests can feed arbitrary data in and snapshot the output — no Ruby, no
// Selenium, no polling URL.
//
// TRMNL plugins use one non-standard Liquid construct: the `{% template NAME %}
// …{% endtemplate %}` block, which trmnl-liquid implements as a custom block tag
// backed by an in-memory file system (see the gem's TemplateTag < Liquid::Block
// and FileSystem < BlankFileSystem). `{% render 'NAME' %}` then reads partials
// back out of that store. We mirror that 1:1 here: a custom block tag captures
// each template's raw body and registers it under NAME, and a pluggable fs
// resolves `{% render %}` against the same map. Everything else our templates
// use (if/for/assign/render + default/size/replace/prepend) is stock Liquid.
import { Liquid, TokenKind } from "liquidjs";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_SRC = resolve(HERE, "../../plugin/src");

// trmnl-liquid's TemplateTag::NAME_REGEX — letters, numbers, underscores, slashes.
const NAME_RE = /^[a-zA-Z0-9_/]+$/;

export function createEngine() {
  // Backing store for {% template %} → {% render %}, like trmnl-liquid's FileSystem.
  const partials = new Map<string, string>();

  const engine = new Liquid({
    cache: false,
    fs: {
      sep: "/",
      exists: async (fp: string) => partials.has(fp),
      existsSync: (fp: string) => partials.has(fp),
      readFile: async (fp: string) => mustGet(partials, fp),
      readFileSync: (fp: string) => mustGet(partials, fp),
      resolve: (_dir: string, file: string) => file, // the bare NAME is the key
      dirname: (fp: string) => fp,
      contains: () => true,
    },
  });

  engine.registerTag("template", {
    parse(tagToken: any, remainTokens: any[]) {
      this.name = tagToken.args.trim();
      // Capture the RAW body string (offsets into the source), then re-register
      // it so {% render %} parses it the same way trmnl-liquid does.
      const input: string = tagToken.input;
      let bodyBegin: number | null = null;
      let bodyEnd: number | null = null;
      while (remainTokens.length) {
        const tok = remainTokens.shift();
        if (tok.kind === TokenKind.Tag && tok.name === "endtemplate") {
          bodyEnd = tok.begin;
          break;
        }
        if (bodyBegin === null) bodyBegin = tok.begin;
      }
      this.body = bodyBegin !== null && bodyEnd !== null ? input.slice(bodyBegin, bodyEnd) : "";
    },
    render() {
      if (!NAME_RE.test(this.name)) {
        return `Liquid error: invalid template name ${JSON.stringify(this.name)}`;
      }
      partials.set(this.name, this.body.trim());
      return "";
    },
  });

  return {
    /**
     * Render one view (e.g. "full") against `data`, returning the inner HTML the
     * view produces — i.e. what trmnlp would place inside `.view`. shared.liquid
     * is prepended exactly as trmnlp (and production) do, so its {% template %}
     * partials are registered before the view's {% render %} calls run.
     */
    async render(view: string, data: Record<string, unknown>): Promise<string> {
      partials.clear();
      const shared = readFileSync(`${PLUGIN_SRC}/shared.liquid`, "utf8");
      const body = readFileSync(`${PLUGIN_SRC}/${view}.liquid`, "utf8");
      return engine.parseAndRender(shared + body, data);
    },
  };
}

function mustGet(map: Map<string, string>, key: string): string {
  const v = map.get(key);
  if (v === undefined) throw new Error(`Template not found: ${key}`);
  return v;
}
