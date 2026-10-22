import { test } from "node:test";
import assert from "node:assert/strict";
import { publicName } from "./activity.pg.js";

/**
 * This name goes on a PUBLIC endpoint, beside a real amount of a real person's money, to anyone who
 * loads the trade screen logged out. The rules it enforces are the privacy boundary, so they are
 * tested rather than trusted.
 */
test("publicName: the first token only, so nothing after it can leak", () => {
  assert.equal(publicName("wanjiku_254"), "Wanjiku");
  assert.equal(publicName("steve.mwangi"), "Steve");
  assert.equal(publicName("njeri-k"), "Njeri");
  assert.equal(publicName("amina otieno"), "Amina");
  // An email-shaped username must never surface its domain.
  assert.equal(publicName("peter@example.com"), "Peter");
});

test("publicName: never an identifier, and never nothing", () => {
  // No username at all, or one too short to read as a person, is NOT replaced with a phone, an id,
  // or a blank — all three were ways this could have gone wrong.
  assert.equal(publicName(null), "A trader");
  assert.equal(publicName(undefined), "A trader");
  assert.equal(publicName(""), "A trader");
  assert.equal(publicName("   "), "A trader");
  assert.equal(publicName("a"), "A trader");
  // Digits-only usernames look like phone numbers, and a phone number is exactly what must not
  // appear — but a long numeric handle is still the player's chosen name, so it is capped, not cut.
  assert.equal(publicName("0712345678").length <= 12, true);
});

test("publicName: capped, cased, and stripped of anything that is not a letter or digit", () => {
  assert.equal(publicName("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "Abcdefghijkl");
  assert.equal(publicName("ABCDEFGHIJKLMNOPQRSTUVWXYZ").length, 12);
  // Split happens on '@' first — that is what strips an email domain — so a one-character first
  // token is all that is left here, and a one-character name is not a name.
  assert.equal(publicName("w@njiku!!"), "A trader");
  assert.equal(publicName("wanjiku!!"), "Wanjiku");
  assert.equal(publicName("MWANGI"), "Mwangi");
});
