import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type PublicationIntent = {
  assessmentId: string;
  resultSha256: string;
  origin: string;
  disposition: string;
};
export type PublicationReceipt = PublicationIntent & {
  outcome: "accepted" | "rejected" | "unknown";
  httpStatus: number | null;
};
/** Reservation must be durable before the first publication request. */
export interface PublicationJournal {
  has(assessmentId: string): Promise<boolean>;
  reserve(intent: PublicationIntent): Promise<void>;
  complete(receipt: PublicationReceipt): Promise<void>;
}

export function filePublicationJournal(root: string): PublicationJournal {
  return {
    async has(id) {
      try {
        await stat(join(root, id));
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async reserve(intent) {
      await mkdir(root, { recursive: true, mode: 0o700 });
      const directory = join(root, intent.assessmentId);
      await mkdir(directory, { mode: 0o700 });
      await writeFile(join(directory, "intent.json"), JSON.stringify(intent), {
        mode: 0o600,
        flag: "wx",
      });
    },
    async complete(receipt) {
      await writeFile(
        join(root, receipt.assessmentId, "receipt.json"),
        JSON.stringify(receipt),
        { mode: 0o600, flag: "wx" },
      );
    },
  };
}

/** Protected scheduled jobs use D1 for metadata only; no source or model text. */
export function d1PublicationJournal(config: {
  accountId: string;
  databaseId: string;
  token: string;
  fetch?: typeof fetch;
}): PublicationJournal {
  if (
    !/^[a-f0-9]{32}$/.test(config.accountId) ||
    !/^[a-f0-9-]{36}$/.test(config.databaseId) ||
    !config.token
  )
    throw new Error("Invalid publication journal configuration");
  async function query(sql: string, params: (string | number | null)[]) {
    const response = await (config.fetch ?? fetch)(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql, params }),
      },
    );
    if (!response.ok) throw new Error("Publication journal unavailable");
    const body = (await response.json()) as {
      success?: boolean;
      result?: { success?: boolean; results?: unknown[] }[];
    };
    if (
      body.success !== true ||
      body.result?.length !== 1 ||
      body.result[0].success !== true ||
      !Array.isArray(body.result[0].results)
    )
      throw new Error("Invalid publication journal response");
    return body.result[0].results;
  }
  return {
    async has(id) {
      return (
        (
          await query(
            "SELECT assessment_id FROM vetting_publication_intents WHERE assessment_id=?",
            [id],
          )
        ).length > 0
      );
    },
    async reserve(intent) {
      const inserted = await query(
        "INSERT INTO vetting_publication_intents(assessment_id,result_sha256,origin,disposition) VALUES(?,?,?,?) ON CONFLICT(assessment_id) DO NOTHING RETURNING assessment_id",
        [
          intent.assessmentId,
          intent.resultSha256,
          intent.origin,
          intent.disposition,
        ],
      );
      if (inserted.length !== 1)
        throw new Error("Publication already reserved; reconcile its outcome");
    },
    async complete(receipt) {
      const inserted = await query(
        "INSERT INTO vetting_publication_receipts(assessment_id,outcome,http_status) SELECT assessment_id,?,? FROM vetting_publication_intents WHERE assessment_id=? AND result_sha256=? AND origin=? AND disposition=? RETURNING assessment_id",
        [
          receipt.outcome,
          receipt.httpStatus,
          receipt.assessmentId,
          receipt.resultSha256,
          receipt.origin,
          receipt.disposition,
        ],
      );
      if (inserted.length !== 1)
        throw new Error("Publication receipt has no matching intent");
    },
  };
}
