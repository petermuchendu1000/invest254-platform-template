import type { KycStatus, KycStore, KycSubmission } from "./app.kyc.js";

/** ACCT-1: KycStore over the 0168 RPCs + brand-scoped reads (the API runs as service_role). */
export interface KycQuerier { query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }
const iso = (v: unknown): string | null => (v == null ? null : v instanceof Date ? v.toISOString() : String(v));
const COLS = `k.id, k.user_id, k.site_id, p.username, p.phone, k.status, k.doc_type, k.full_name, k.id_number,
              to_char(k.date_of_birth, 'YYYY-MM-DD') as dob, k.front_file, k.back_file, k.selfie_file,
              k.submitted_at, k.reviewed_at, r.username as reviewer, k.review_note`;
const FROM = `from kyc_submissions k join profiles p on p.id = k.user_id left join profiles r on r.id = k.reviewed_by`;
function map(x: Record<string, unknown>): KycSubmission {
  return {
    id: String(x.id), userId: String(x.user_id), siteId: String(x.site_id), username: (x.username as string | null) ?? null, phone: (x.phone as string | null) ?? null,
    status: x.status as KycSubmission["status"], docType: x.doc_type as KycSubmission["docType"], fullName: String(x.full_name), idNumber: String(x.id_number),
    dateOfBirth: String(x.dob), frontFile: String(x.front_file), backFile: (x.back_file as string | null) ?? null, selfieFile: String(x.selfie_file),
    submittedAt: iso(x.submitted_at)!, reviewedAt: iso(x.reviewed_at), reviewerName: (x.reviewer as string | null) ?? null, reviewNote: (x.review_note as string | null) ?? null,
  };
}
export function makePgKycStore(q: KycQuerier): KycStore {
  return {
    async status(userId) {
      const r = await q.query("select kyc_status from profiles where id = $1", [userId]);
      return (r.rows[0]?.kyc_status as KycStatus | undefined) ?? "none";
    },
    async latest(userId) {
      const r = await q.query(`select ${COLS} ${FROM} where k.user_id = $1 order by k.submitted_at desc limit 1`, [userId]);
      return r.rows.length ? map(r.rows[0]!) : null;
    },
    async upload(userId, mime, data) {
      const r = await q.query("select fn_kyc_upload($1, $2, $3) as id", [userId, mime, data]);
      return String(r.rows[0]!.id);
    },
    async submit(userId, siteId, s) {
      const r = await q.query("select fn_kyc_submit($1,$2,$3,$4,$5,$6::date,$7,$8,$9) as id",
        [userId, siteId, s.docType, s.fullName, s.idNumber, s.dateOfBirth, s.frontId, s.backId, s.selfieId]);
      return String(r.rows[0]!.id);
    },
    async list(siteId, status, userId, limit) {
      const r = await q.query(
        `select ${COLS} ${FROM}
          where ($1::uuid is null or k.site_id = $1) and ($2 = 'all' or k.status = $2) and ($3::uuid is null or k.user_id = $3)
          order by k.submitted_at ${status === "pending" ? "asc" : "desc"} limit $4`,
        [siteId, status, userId, limit]);
      return r.rows.map(map);
    },
    async get(id) {
      const r = await q.query(`select ${COLS} ${FROM} where k.id = $1`, [id]);
      return r.rows.length ? map(r.rows[0]!) : null;
    },
    async review(actorId, actorRole, id, decision, note) {
      const r = await q.query("select fn_kyc_review($1,$2,$3,$4,$5) as d", [actorId, actorRole, id, decision, note]);
      return String(r.rows[0]!.d);
    },
    async file(id) {
      const r = await q.query("select mime, data from kyc_files where id = $1", [id]);
      return r.rows.length ? { mime: String(r.rows[0]!.mime), data: r.rows[0]!.data as Buffer } : null;
    },
  };
}
