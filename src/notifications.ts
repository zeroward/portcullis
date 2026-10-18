import nodemailer from "nodemailer";
import type { Database } from "./db/index.js";
import type { Config } from "./config.js";
import { signedBody } from "./security.js";
import { ProviderError } from "./providers/http.js";
export class Notifications {
  constructor(
    readonly db: Database,
    readonly config: Config,
  ) {}
  async deliver(id: string) {
    const [n] = await this.db.query(
      "SELECT n.*,u.email FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.id=$1",
      [id],
    );
    if (!n) return;
    const prefs = await this.db.query(
      "SELECT channel FROM notification_preferences WHERE user_id=$1 AND enabled",
      [n.user_id],
    );
    let failed = false;
    for (const { channel } of prefs) {
      if (
        (
          await this.db.query(
            "SELECT 1 FROM delivery_attempts WHERE notification_id=$1 AND channel=$2 AND status='sent'",
            [id, channel],
          )
        ).length
      )
        continue;
      try {
        // Outgoing content is generic. Authorized details are behind the portal link.
        const content = {
          event: n.kind,
          message: "There is an update in Portcullis.",
          url: new URL(n.link, this.config.BASE_URL).href,
          id: n.id,
        };
        if (channel === "smtp") {
          if (!this.config.SMTP_URL || !n.email) continue;
          const server = new URL(this.config.SMTP_URL);
          const smtp = nodemailer.createTransport({
            host: server.hostname,
            port: Number(
              server.port || (server.protocol === "smtps:" ? 465 : 587),
            ),
            secure: server.protocol === "smtps:",
            auth: server.username
              ? {
                  user: decodeURIComponent(server.username),
                  pass: decodeURIComponent(server.password),
                }
              : undefined,
            connectionTimeout: 8000,
            greetingTimeout: 8000,
            socketTimeout: 8000,
          });
          await smtp.sendMail({
            from: this.config.SMTP_FROM,
            to: n.email,
            subject: "Portcullis update",
            text: `${content.message}\n${content.url}`,
            messageId: `<${n.id}@portcullis.local>`,
          });
        } else if (channel === "discord") {
          if (!this.config.DISCORD_WEBHOOK_URL) continue;
          const r = await fetch(this.config.DISCORD_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: `${content.message} ${this.config.BASE_URL}`,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error("delivery_failed");
        } else if (channel === "webhook") {
          if (
            !this.config.OUTGOING_WEBHOOK_URL ||
            !this.config.OUTGOING_WEBHOOK_KEY
          )
            continue;
          const body = JSON.stringify(content);
          const r = await fetch(this.config.OUTGOING_WEBHOOK_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-portcullis-signature": signedBody(
                body,
                this.config.OUTGOING_WEBHOOK_KEY,
              ),
              "idempotency-key": n.id,
            },
            body,
            redirect: "error",
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) throw new Error("delivery_failed");
        } else continue;
        await this.db.query(
          "INSERT INTO delivery_attempts(notification_id,channel,status) VALUES ($1,$2,'sent')",
          [id, channel],
        );
      } catch {
        failed = true;
        await this.db.query(
          "INSERT INTO delivery_attempts(notification_id,channel,status,error) VALUES ($1,$2,'failed','delivery_failed')",
          [id, channel],
        );
      }
    }
    if (failed) throw new ProviderError("unavailable", "notifications", true);
  }
}
