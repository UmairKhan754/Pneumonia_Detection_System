// Import the functions you need from the SDKs you need
import { initializeApp } from "firebase/app";
import { getAnalytics } from "firebase/analytics";
// TODO: Add SDKs for Firebase products that you want to use
// https://firebase.google.com/docs/web/setup#available-libraries

// Your web app's Firebase configuration
// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyDTmx03EnSPLt57SbdbD_5S1XsnfuaOTVA",
  authDomain: "pneumoniaweb-661c0.firebaseapp.com",
  projectId: "pneumoniaweb-661c0",
  storageBucket: "pneumoniaweb-661c0.firebasestorage.app",
  messagingSenderId: "414424891037",
  appId: "1:414424891037:web:643911cd9c8eaa98299e74",
  measurementId: "G-L6YYPPZXKN",
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
