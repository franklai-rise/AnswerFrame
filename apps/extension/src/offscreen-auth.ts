import { initializeApp, getApps } from "firebase/app";
import { GoogleAuthProvider, signInWithPopup } from "firebase/auth";
import { getAuth } from "firebase/auth/web-extension";

// Fill these values in a private extension build. Empty values intentionally
// fall back to the web app sign-in during the public development rollout.
const firebaseConfig = {
  apiKey: "",
  authDomain: "",
  projectId: "",
  storageBucket: "",
  messagingSenderId: "",
  appId: "",
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "offscreen-auth-google") return false;
  if (!Object.values(firebaseConfig).every(Boolean)) {
    sendResponse({ error: "请在 AnswerFrame 网页设置中完成 Google 登录" });
    return false;
  }
  try {
    const app = getApps()[0] ?? initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const provider = new GoogleAuthProvider();
    void signInWithPopup(auth, provider)
      .then(async (result) => sendResponse({ uid: result.user.uid, idToken: await result.user.getIdToken() }))
      .catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  } catch (error) {
    sendResponse({ error: error instanceof Error ? error.message : String(error) });
    return false;
  }
});
