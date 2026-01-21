import { initializeApp } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyD08m5A0JA1VLkJkZ6Ktoz5dq6bVEgCLwA",
  authDomain: "sales-route-management.firebaseapp.com",
  projectId: "sales-route-management",
  storageBucket: "sales-route-management.firebasestorage.app",
  messagingSenderId: "676952991059",
  appId: "1:676952991059:web:910d0abca29c256636ada6"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

export { auth, db };
