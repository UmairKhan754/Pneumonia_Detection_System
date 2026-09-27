// /js/firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-firestore.js";

// NOTE: this keeps your original config (you can rotate/remove keys later)
const firebaseConfig = {
  apiKey: "AIzaSyDTmx03EnSPLt57SbdbD_5S1XsnfuaOTVA",
  authDomain: "pneumoniaweb-661c0.firebaseapp.com",
  projectId: "pneumoniaweb-661c0",
  storageBucket: "pneumoniaweb-661c0.firebasestorage.app",
  messagingSenderId: "414424891037",
  appId: "1:414424891037:web:643911cd9c8eaa98299e74",
  measurementId: "G-L6YYPPZXKN",
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
