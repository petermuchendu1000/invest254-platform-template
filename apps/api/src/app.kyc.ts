import { type Router, type Ctx, ApiError, requireAuth, requireSite, requireSiteAdmin, adminListSite, rateLimit } from "./http.js";
import type { ApiDeps } from "./app.js";
import { signMedia, verifyMedia } from "./app.livechat.js";

/**
 * ACCT-1 (migration 0168) — player identity verification.
 *
 *   Player  GET  /kyc                  status + latest submission (with the reviewer's note)
 *           POST /kyc/files            raw bytes (JPEG / PNG / WebP / PDF, <= 6 MB) -> { id }
 *           POST /kyc                  { docType, fullName, idNumber, dateOfBirth, frontId, backId?, selfieId }
 *   Staff   GET  /admin/kyc            brand-scoped list (?status=pending|approved|rejected|all, ?userId=)
 *           GET  /admin/kyc/:id        one submission with signed links to its files
 *           POST /admin/kyc/:id/decision  { decision: approved|rejected, note }
 *   Files   GET  /kyc/file/:id?t=      signed, short-lived link (staff only get these links)
 *
 * Nothing here moves money or blocks withdrawals; the status is informational.
 */
export type KycStatus = "none" | "pending" | "approved" | "rejected";
export interface KycSubmission {
  id: string; userId: string; siteId: string; username: string | null; phone: string | null;
  status: "pending" | "approved" | "rejected"; docType: "national_id" | "passport" | "driving_licence";
  fullName: string; idNumber: string; dateOfBirth: string;
  frontFile: string; backFile: string | null; selfieFile: string;
  submittedAt: string; reviewedAt: string | null; reviewerName: string | null; reviewNote: string | null;
}
export interface KycStore {
  status(userId: string): Promise<KycStatus>;
  latest(userId: string): Promise<KycSubmission | null>;
  upload(userId: string, mime: string, data: Buffer): Promise<string>;
  submit(userId: string, siteId: string, s: { docType: string; fullName: string; idNumber: string; dateOfBirth: string; frontId: string; backId: string | null; selfieId: string }): Promise<string>;
  list(siteId: string | null, status: "pending" | "approved" | "rejected" | "all", userId: string | null, limit: number): Promise<KycSubmission[]>;
  get(id: string): Promise<KycSubmission | null>;
  review(actorId: string, actorRole: string, id: string, decision: "approved" | "rejected", note: string | null): Promise<string>;
  file(id: string): Promise<{ mime: string; data: Buffer } | null>;
}
export interface KycDeps { store: KycStore; mediaSecret: string; }

const BASE = "/api/v1";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ERR: Record<string, [number, string]> = {
  UNSUPPORTED_FILE: [415, "Upload a photo (JPG, PNG, WebP) or a PDF."],
  EMPTY_FILE: [400, "That file is empty."],
  FILE_TOO_LARGE: [413, "Each file can be up to 6 MB."],
  TOO_MANY_UPLOADS: [429, "Too many uploads today. Try again tomorrow."],
  NOT_YOUR_BRAND: [403, "This account belongs to another brand."],
  ALREADY_VERIFIED: [409, "Your identity is already verified."],
  ALREADY_PENDING: [409, "Your documents are already being reviewed."],
  INVALID_DOB: [400, "Enter your date of birth as on the document (you must be 18 or older)."],
  FILE_NOT_FOUND: [400, "One of the files is missing. Upload it again."],
  SELFIE_MUST_BE_PHOTO: [400, "The selfie must be a photo, not a PDF."],
  FILE_REUSED: [400, "Use a different file for each side and for the selfie."],
  INVALID_DECISION: [400, "Decision must be approved or rejected."],
  NOTE_REQUIRED: [400, "Tell the player why, so they can fix it."],
  SUBMISSION_NOT_FOUND: [404, "Submission not found."],
  ALREADY_REVIEWED: [409, "This submission was already reviewed."],
  SITE_SCOPE_FORBIDDEN: [404, "Submission not found."],
  NOT_AUTHORIZED: [403, "Not allowed."],
};
async function kycDomain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (err) {
    if (err instanceof ApiError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    const code = msg.split(":")[0]!.trim();
    const hit = ERR[code];
    if (hit) throw new ApiError(code, hit[1], hit[0]);
    if (/violates check constraint/.test(msg)) throw new ApiError("INVALID_DETAILS", "Check the name and ID number and try again.", 400);
    throw err;
  }
}
const DOC_TYPES = new Set(["national_id", "passport", "driving_licence"]);

export function registerKycRoutes(router: Router, deps: ApiDeps): void {
  const k = deps.kyc;
  if (!k) return;
  const { store, mediaSecret } = k;
  const auth = requireAuth(deps.verifier);
  const site = requireSite();
  const staff = requireSiteAdmin("admin");
  const upLimit = rateLimit({ name: "kyc-upload", by: "user", limit: 12, windowMs: 60 * 60_000 });
  const fileKey = (id: string) => `kyc:${id}`;
  const link = (id: string | null) => (id ? `${BASE}/kyc/file/${id}?t=${encodeURIComponent(signMedia(mediaSecret, fileKey(id)))}` : null);
  const customer = (ctx: Ctx) => {
    const role = ctx.claims?.role ?? "player";
    if (role !== "player" && role !== "marketer") throw new ApiError("CUSTOMERS_ONLY", "Identity checks are for player accounts.", 403);
  };
  const playerView = (s: KycSubmission | null) => s ? {
    status: s.status, docType: s.docType, submittedAt: s.submittedAt, reviewedAt: s.reviewedAt, reviewNote: s.reviewNote,
  } : null;
  const staffView = (s: KycSubmission, withFiles: boolean) => ({
    id: s.id, userId: s.userId, siteId: s.siteId, username: s.username, phone: s.phone, status: s.status, docType: s.docType,
    fullName: s.fullName, idNumber: s.idNumber, dateOfBirth: s.dateOfBirth, submittedAt: s.submittedAt,
    reviewedAt: s.reviewedAt, reviewerName: s.reviewerName, reviewNote: s.reviewNote,
    ...(withFiles ? { files: { front: link(s.frontFile), back: link(s.backFile), selfie: link(s.selfieFile) } } : {}),
  });

  router.get(`${BASE}/kyc`, auth, site, async (ctx: Ctx) => {
    customer(ctx);
    return { status: await store.status(ctx.claims!.userId), latest: playerView(await store.latest(ctx.claims!.userId)) };
  });
  router.upload(`${BASE}/kyc/files`, 6 * 1024 * 1024, auth, site, upLimit, async (ctx: Ctx) => {
    customer(ctx);
    const mime = String(ctx.req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const id = await kycDomain(() => store.upload(ctx.claims!.userId, mime, ctx.body as Buffer));
    return { status: 201, body: { id } };
  });
  router.post(`${BASE}/kyc`, auth, site, async (ctx: Ctx) => {
    customer(ctx);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const str = (key: string, max: number) => (typeof b[key] === "string" ? (b[key] as string).trim().slice(0, max) : "");
    const docType = str("docType", 30);
    if (!DOC_TYPES.has(docType)) throw new ApiError("INVALID_DOC_TYPE", "Choose National ID, Passport or Driving licence.", 400);
    const fullName = str("fullName", 120), idNumber = str("idNumber", 40), dateOfBirth = str("dateOfBirth", 10);
    if (fullName.length < 3) throw new ApiError("INVALID_DETAILS", "Enter your full name as on the document.", 400);
    if (idNumber.length < 4) throw new ApiError("INVALID_DETAILS", "Enter the document number.", 400);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) throw new ApiError("INVALID_DOB", "Enter your date of birth.", 400);
    const frontId = str("frontId", 36), selfieId = str("selfieId", 36), backId = str("backId", 36) || null;
    if (!UUID_RE.test(frontId) || !UUID_RE.test(selfieId) || (backId && !UUID_RE.test(backId))) throw new ApiError("FILE_NOT_FOUND", "Upload the document and the selfie first.", 400);
    const id = await kycDomain(() => store.submit(ctx.claims!.userId, ctx.siteId!, { docType, fullName, idNumber, dateOfBirth, frontId, backId, selfieId }));
    return { status: 201, body: { id, status: "pending" } };
  });

  router.get(`${BASE}/kyc/file/:id`, async (ctx: Ctx) => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id) || !verifyMedia(mediaSecret, fileKey(id), ctx.query.get("t") ?? "")) throw new ApiError("NOT_FOUND", "file not found", 404);
    const f = await store.file(id);
    if (!f) throw new ApiError("NOT_FOUND", "file not found", 404);
    return { raw: f.data, contentType: f.mime, cacheSeconds: 0 };
  });

  router.get(`${BASE}/admin/kyc`, auth, site, staff, async (ctx: Ctx) => {
    const st = ctx.query.get("status");
    const status = st === "approved" || st === "rejected" || st === "all" ? st : "pending";
    const userId = ctx.query.get("userId");
    const items = await store.list(adminListSite(ctx) ?? null, userId ? "all" : status, userId && UUID_RE.test(userId) ? userId : null, 100);
    return { items: items.map((s) => staffView(s, false)) };
  });
  const scoped = async (ctx: Ctx): Promise<KycSubmission> => {
    const id = ctx.params.id!;
    if (!UUID_RE.test(id)) throw new ApiError("INVALID_ID", "submission id must be a UUID", 400);
    const s = await store.get(id);
    const scope = adminListSite(ctx) ?? null;
    if (!s || (scope !== null && s.siteId !== scope)) throw new ApiError("NOT_FOUND", "Submission not found.", 404);
    return s;
  };
  router.get(`${BASE}/admin/kyc/:id`, auth, site, staff, async (ctx: Ctx) => ({ submission: staffView(await scoped(ctx), true) }));
  router.post(`${BASE}/admin/kyc/:id/decision`, auth, site, staff, async (ctx: Ctx) => {
    const s = await scoped(ctx);
    const b = (ctx.body ?? {}) as Record<string, unknown>;
    const decision = b.decision;
    if (decision !== "approved" && decision !== "rejected") throw new ApiError("INVALID_DECISION", ERR.INVALID_DECISION![1], 400);
    const note = typeof b.note === "string" ? b.note.trim().slice(0, 500) : null;
    const out = await kycDomain(() => store.review(ctx.claims!.userId, ctx.claims!.role ?? "admin", s.id, decision, note || null));
    return { status: out };
  });
}

/** In-memory store (tests / dev), mirroring 0168's rules the API relies on. */
export class InMemoryKycStore implements KycStore {
  subs: KycSubmission[] = [];
  files = new Map<string, { userId: string; mime: string; data: Buffer; used: boolean }>();
  statusBy = new Map<string, KycStatus>();
  users = new Map<string, { siteId: string; username: string }>();
  private n = 0;
  private uid() { this.n += 1; return `00000000-0000-4000-9000-${String(this.n).padStart(12, "0")}`; }
  async status(userId: string) { return this.statusBy.get(userId) ?? "none"; }
  async latest(userId: string) { return [...this.subs].reverse().find((s) => s.userId === userId) ?? null; }
  async upload(userId: string, mime: string, data: Buffer) {
    if (!["image/jpeg", "image/png", "image/webp", "application/pdf"].includes(mime)) throw new Error("UNSUPPORTED_FILE");
    if (!data.length) throw new Error("EMPTY_FILE");
    if (data.length > 6291456) throw new Error("FILE_TOO_LARGE");
    const id = this.uid(); this.files.set(id, { userId, mime, data, used: false }); return id;
  }
  async submit(userId: string, siteId: string, s: { docType: string; fullName: string; idNumber: string; dateOfBirth: string; frontId: string; backId: string | null; selfieId: string }) {
    const u = this.users.get(userId);
    if (u && u.siteId !== siteId) throw new Error("NOT_YOUR_BRAND");
    if (this.statusBy.get(userId) === "approved") throw new Error("ALREADY_VERIFIED");
    if (this.subs.some((x) => x.userId === userId && x.status === "pending")) throw new Error("ALREADY_PENDING");
    const dob = new Date(s.dateOfBirth);
    if (Number.isNaN(dob.getTime()) || dob > new Date(Date.now() - 18 * 365.25 * 86400_000)) throw new Error("INVALID_DOB");
    for (const f of [s.frontId, s.selfieId, s.backId]) {
      if (!f) continue;
      const file = this.files.get(f);
      if (!file || file.userId !== userId || file.used) throw new Error("FILE_NOT_FOUND");
    }
    if (this.files.get(s.selfieId)!.mime === "application/pdf") throw new Error("SELFIE_MUST_BE_PHOTO");
    if (new Set([s.frontId, s.selfieId, s.backId].filter(Boolean)).size !== [s.frontId, s.selfieId, s.backId].filter(Boolean).length) throw new Error("FILE_REUSED");
    const id = this.uid();
    this.subs.push({ id, userId, siteId, username: u?.username ?? null, phone: null, status: "pending", docType: s.docType as KycSubmission["docType"],
      fullName: s.fullName, idNumber: s.idNumber.toUpperCase(), dateOfBirth: s.dateOfBirth, frontFile: s.frontId, backFile: s.backId, selfieFile: s.selfieId,
      submittedAt: new Date().toISOString(), reviewedAt: null, reviewerName: null, reviewNote: null });
    for (const f of [s.frontId, s.selfieId, s.backId]) if (f) this.files.get(f)!.used = true;
    this.statusBy.set(userId, "pending");
    return id;
  }
  async list(siteId: string | null, status: "pending" | "approved" | "rejected" | "all", userId: string | null, limit: number) {
    return this.subs.filter((s) => (siteId === null || s.siteId === siteId) && (status === "all" || s.status === status) && (!userId || s.userId === userId)).slice(-limit).reverse();
  }
  async get(id: string) { return this.subs.find((s) => s.id === id) ?? null; }
  async review(_actor: string, role: string, id: string, decision: "approved" | "rejected", note: string | null) {
    if (!["admin", "platform_admin", "platform_superadmin"].includes(role)) throw new Error("NOT_AUTHORIZED");
    if (decision === "rejected" && !note) throw new Error("NOTE_REQUIRED");
    const s = this.subs.find((x) => x.id === id);
    if (!s) throw new Error("SUBMISSION_NOT_FOUND");
    if (s.status !== "pending") throw new Error("ALREADY_REVIEWED");
    s.status = decision; s.reviewNote = note; s.reviewedAt = new Date().toISOString();
    this.statusBy.set(s.userId, decision);
    return decision;
  }
  async file(id: string) { const f = this.files.get(id); return f ? { mime: f.mime, data: f.data } : null; }
}
