import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

// DOM Elements
const bodyContent = document.body; // or a specific wrapper div
// Initially hide content to prevent "flashing" unauthorized data
bodyContent.style.visibility = "hidden"; 

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        // No user logged in -> Kick out
        window.location.href = 'index.html';
        return;
    }

    // User is logged in, but are they an Admin?
    try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (userDoc.exists() && userDoc.data().role === 'admin') {
            // Authorized! Show content.
            bodyContent.style.visibility = "visible";
            console.log("Admin access granted.");
        } else {
            // Logged in, but WRONG role (e.g., a Salesman trying to access Admin page)
            alert("Access Denied: You do not have Admin privileges.");
            await logoutUser();
        }
    } catch (error) {
        console.error("Auth Check Error:", error);
        window.location.href = 'index.html';
    }
});

// Attach Logout Listener if button exists
const btn = document.getElementById('logoutBtn');
if(btn) btn.addEventListener('click', logoutUser);
