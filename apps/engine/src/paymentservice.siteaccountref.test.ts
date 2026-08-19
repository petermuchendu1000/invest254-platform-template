import { test } from "node:test";
import assert from "node:assert/strict";
import { PaymentService } from "./paymentservice.js";
import { InMemoryPaymentRepository } from "./payments.js";
import { StubDarajaClient, type StkPushArgs, type StkPushResult, type DarajaClient } from "./daraja.js";

/** A Daraja client that records the AccountReference each STK push was built with. */
class RecordingDaraja extends StubDarajaClient {
  public readonly refs: string[] = [];
  public label: string;
  constructor(label = "shared") { super(); this.label = label; }
  override async stkPush(a: StkPushArgs): Promise<StkPushResult> {
    this.refs.push(a.accountRef);
    return super.stkPush(a);
  }
}

const SITE_A = "00000000-0000-0000-0000-000000000001";
const SITE_B = "22222222-2222-2222-2222-222222222222";

test("STK AccountReference is the depositing brand (site-aware), sanitised + fallback", async () => {
  const daraja = new RecordingDaraja();
  const repo = new InMemoryPaymentRepository();
  for (const u of ["u1", "u2", "u3"]) repo.seed(u, 100_000);
  const names: Record<string, string> = { [SITE_A]: "Invest254", [SITE_B]: "Tamu Traders" };
  const svc = new PaymentService(repo, daraja, {
    accountRefForSite: (siteId) => names[siteId ?? ""] ?? "",
    defaultAccountRef: "Invest254",
  });

  await svc.initiateDeposit("u1", 50_000, "0712345678", SITE_A);
  await svc.initiateDeposit("u2", 50_000, "0712345678", SITE_B);      // "Tamu Traders" -> sanitised
  await svc.initiateDeposit("u3", 50_000, "0712345678", undefined);   // no site -> fallback

  assert.equal(daraja.refs[0], "Invest254", "brand A account ref");
  assert.equal(daraja.refs[1], "TamuTraders", "spaces stripped, <=12 chars");
  assert.equal(daraja.refs[2], "Invest254", "fallback when no per-site ref");
});

test("STK routes through the brand's OWN Daraja client when configured, else the shared one", async () => {
  const shared = new RecordingDaraja("shared");
  const brandB = new RecordingDaraja("brandB");
  const perSite: Record<string, DarajaClient> = { [SITE_B]: brandB };
  const repo = new InMemoryPaymentRepository();
  for (const u of ["u1", "u2"]) repo.seed(u, 100_000);
  const svc = new PaymentService(repo, shared, {
    accountRefForSite: () => "Acct",
    darajaForSite: (siteId) => perSite[siteId ?? ""],
  });

  await svc.initiateDeposit("u1", 50_000, "0712345678", SITE_A);   // no own client -> shared
  await svc.initiateDeposit("u2", 50_000, "0712345678", SITE_B);   // own client -> brandB

  assert.equal(shared.refs.length, 1, "brand A used the shared client");
  assert.equal(brandB.refs.length, 1, "brand B routed through its own paybill client");
});
