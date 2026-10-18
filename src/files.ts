import { randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./db/index.js";
import type { Config } from "./config.js";
import type { Actor } from "./domain/authorization.js";
import { requirePermission } from "./domain/authorization.js";
import type { Tickets } from "./domain/tickets.js";
import type { Guides } from "./domain/guides.js";
import { invariant } from "./errors.js";
import { audit } from "./domain/audit.js";
export function validFile(mime: string, data: Buffer, guide = false) {
  if (!data.length || data.length > 5242880) return false;
  if (mime === "application/pdf")
    return data.subarray(0, 5).toString() === "%PDF-";
  if (guide) return false;
  if (mime === "image/png")
    return data
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return data[0] === 255 && data[1] === 216 && data[2] === 255;
  if (mime === "text/plain")
    return !data.includes(0) && !data.toString().includes("<script");
  return false;
}
export class Files {
  constructor(
    readonly db: Database,
    readonly config: Config,
    readonly tickets: Tickets,
    readonly guides: Guides,
  ) {}
  async authorize(actor: Actor, a: any, write = false) {
    if (a.ticket_id) await this.tickets.visible(actor, a.ticket_id);
    if (a.guide_id) {
      const g = await this.guides.get(actor, a.guide_id);
      if (write) requirePermission(actor, "guides.manage", g.service_id ?? "*");
    }
  }
  async upload(
    actor: Actor,
    target: { ticket_id?: string; guide_id?: string },
    name: string,
    mime: string,
    data: Buffer,
  ) {
    invariant(
      !!target.ticket_id !== !!target.guide_id,
      "one_file_target_required",
    );
    await this.authorize(actor, target, true);
    invariant(
      validFile(mime, data, !!target.guide_id),
      "file_type_or_size_rejected",
    );
    const key = randomUUID();
    await mkdir(this.config.UPLOAD_DIR, { recursive: true });
    const filename = path.join(this.config.UPLOAD_DIR, key);
    await writeFile(filename, data, { mode: 0o600, flag: "wx" });
    try {
      return await this.db.transaction(async (tx) => {
        const [a] = await tx.query(
          "INSERT INTO attachments(ticket_id,guide_id,uploader_id,storage_key,name,mime,size) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,mime,size",
          [
            target.ticket_id ?? null,
            target.guide_id ?? null,
            actor.id,
            key,
            path
              .basename(name)
              .replace(/[\r\n"\\]/g, "_")
              .slice(0, 180),
            mime,
            data.length,
          ],
        );
        await audit(tx, actor.id, "file.upload", a.id, {
          size: data.length,
          mime,
        });
        return a;
      });
    } catch (e) {
      await unlink(filename);
      throw e;
    }
  }
  async download(actor: Actor, id: string) {
    const [a] = await this.db.query("SELECT * FROM attachments WHERE id=$1", [
      id,
    ]);
    invariant(a, "not_found", 404);
    await this.authorize(actor, a);
    invariant(/^[0-9a-f-]{36}$/.test(a.storage_key), "invalid_storage_key");
    return {
      ...a,
      data: await readFile(path.join(this.config.UPLOAD_DIR, a.storage_key)),
    };
  }
}
