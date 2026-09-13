/**
 * Admin passcode fast-path — the owner may log in with a single passcode
 * (ADMIN_PASSCODE) instead of email+password. Same session cookie, brute-force
 * guard, constant-time compare, and the route is DISABLED when unconfigured.
 */

import type { DataSource } from "typeorm";
import { AuthService } from "../src/services/auth/AuthService";
import { HttpError } from "../src/types";

const OWNER = { id: "acc-owner-1", username: "owner", passwordHash: "x" };
const fakeDs = (account: unknown = OWNER): DataSource =>
  ({ getRepository: () => ({ findOne: async () => account }) }) as unknown as DataSource;

const PASSCODE = "248007";

beforeAll(() => {
  process.env.SESSION_SECRET = "test-session-secret-please-1234567890";
  process.env.OWNER_USER = "owner";
});

describe("loginWithPasscode", () => {
  beforeEach(() => { process.env.ADMIN_PASSCODE = PASSCODE; });

  test("correct passcode logs in as the owner and issues a verifiable token", async () => {
    const svc = new AuthService(fakeDs());
    const { identity, token, expiresAt } = await svc.loginWithPasscode(PASSCODE, "1.2.3.4");
    expect(identity).toEqual({ accountId: "acc-owner-1", username: "owner" });
    expect(typeof token).toBe("string");
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(svc.verifyToken(token)).toEqual(identity); // round-trips
  });

  test("wrong passcode is rejected 401 (and a wrong-length one does not throw)", async () => {
    const svc = new AuthService(fakeDs());
    await expect(svc.loginWithPasscode("000000", "1.2.3.4")).rejects.toMatchObject({ statusCode: 401 });
    await expect(svc.loginWithPasscode("12", "1.2.3.4")).rejects.toMatchObject({ statusCode: 401 });
    await expect(svc.loginWithPasscode("248007248007", "1.2.3.4")).rejects.toMatchObject({ statusCode: 401 });
  });

  test("passcode login is DISABLED (403) when ADMIN_PASSCODE is unset or too short", async () => {
    const svc = new AuthService(fakeDs());
    delete process.env.ADMIN_PASSCODE;
    await expect(svc.loginWithPasscode(PASSCODE, "1.2.3.4")).rejects.toMatchObject({ statusCode: 403 });
    process.env.ADMIN_PASSCODE = "123"; // < 6 chars
    await expect(svc.loginWithPasscode("123", "1.2.3.4")).rejects.toMatchObject({ statusCode: 403 });
  });

  test("brute-force guard: too many wrong attempts from one IP ⇒ 429", async () => {
    const svc = new AuthService(fakeDs());
    for (let i = 0; i < 10; i++) {
      await expect(svc.loginWithPasscode("999999", "9.9.9.9")).rejects.toMatchObject({ statusCode: 401 });
    }
    await expect(svc.loginWithPasscode("999999", "9.9.9.9")).rejects.toMatchObject({ statusCode: 429 });
    // Even the CORRECT passcode is locked out during the window.
    await expect(svc.loginWithPasscode(PASSCODE, "9.9.9.9")).rejects.toMatchObject({ statusCode: 429 });
  });

  test("a correct passcode but a missing owner account is a 500 config error, not a silent login", async () => {
    const svc = new AuthService(fakeDs(null));
    await expect(svc.loginWithPasscode(PASSCODE, "1.2.3.4")).rejects.toBeInstanceOf(HttpError);
    await expect(svc.loginWithPasscode(PASSCODE, "1.2.3.4")).rejects.toMatchObject({ statusCode: 500 });
  });
});
