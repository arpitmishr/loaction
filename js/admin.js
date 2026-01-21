// js/admin.js
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const loader = document.getElementById('loader');
const content = document.getElementById('content');

onAuthStateChanged(auth, async (user) => {
    if (user) {
        // Check if user is actually an admin
        const docRef = doc(db, "users", user.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists() && docSnap.data().role === 'admin') {
            // Success: Show content
            loader.style.display = 'none';
            content.style.display = 'block';
            document.getElementById('user-email').innerText = user.email;
        } else {
            // Wrong role
            alert("Access Denied. Admins only.");
            logoutUser();
        }
    } else {
        // Not logged in
        window.location.href = 'index.html';
    }
});

// Logout Listener
document.getElementById('logoutBtn').addEventListener('click', logoutUser);
