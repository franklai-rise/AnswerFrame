import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";

const email = process.argv[2] || process.env.ANSWERFRAME_OWNER_EMAIL;
if (!email) {
  console.error("Usage: node functions/scripts/grant-owner-claim.mjs owner@example.com");
  process.exit(1);
}

initializeApp();
const auth = getAuth();
const user = await auth.getUserByEmail(email);
const current = user.customClaims || {};
await auth.setCustomUserClaims(user.uid, { ...current, answerframeOwner: true });
console.log(`Granted answerframeOwner to ${email} (${user.uid}). Sign out/in to refresh the ID token.`);
