import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const bodyContent = document.body;
bodyContent.style.visibility = "hidden";

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (userDoc.exists() && userDoc.data().role === 'salesman') {
            // Authorized
            bodyContent.style.visibility = "visible";
            console.log("Salesman access granted.");
        } else {
            // Wrong role
            alert("Access Denied: You are not a Salesman.");
            await logoutUser();
        }
    } catch (error) {
        console.error("Auth Check Error:", error);
        window.location.href = 'index.html';
    }
});

const btn = document.getElementById('logoutBtn');
if(btn) btn.addEventListener('click', logoutUser);
