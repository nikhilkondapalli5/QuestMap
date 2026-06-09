import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider } from "firebase/auth";

console.log("Firebase initializing with keys:", {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY ? "Present" : "Missing",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID ? "Present" : "Missing"
});

const firebaseConfig = {
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY || "dummy_key",
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || "dummy_domain",
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || "dummy_id",
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || "dummy_bucket",
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || "dummy_sender",
    appId: import.meta.env.VITE_FIREBASE_APP_ID || "dummy_app"
};

let auth;
let googleProvider;

try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    googleProvider = new GoogleAuthProvider();
    // Request YouTube read-only access so we can personalise video recommendations
    // based on the user's subscriptions.
    googleProvider.addScope('https://www.googleapis.com/auth/youtube.readonly');
    console.log("Firebase initialized successfully");
} catch (error) {
    console.error("Firebase Initialization Error:", error);
}

export { auth, googleProvider };
