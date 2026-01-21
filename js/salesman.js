// js/salesman.js
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const loader = document.getElementById('loader');
const content = document.getElementById('content');

onAuthStateChanged(auth, async (user) => {
    if (user) {
        const docRef = doc(db, "users", user.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists() && docSnap.data().role === 'salesman') {
            loader.style.display = 'none';
            content.style.display = 'block';
            document.getElementById('user-email').innerText = user.email;
        } else {
            alert("Access Denied. Salesmen only.");
            logoutUser();
        }
    } else {
        window.location.href = 'index.html';
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);
