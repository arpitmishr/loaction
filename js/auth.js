import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

// --- LOGIN FUNCTION ---
export async function loginUser(email, password) {
    try {
        // 1. Authenticate with Firebase Auth
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;

        console.log("Auth successful. Checking role for UID:", user.uid);

        // 2. Fetch User Role from Firestore
        const userDocRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
            const userData = userDoc.data();
            const role = userData.role;

            console.log("User role found:", role);

            // 3. Redirect based on Role
            if (role === 'admin') {
                window.location.href = 'admin.html';
            } else if (role === 'salesman') {
                window.location.href = 'salesman.html';
            } else {
                alert("Login failed: Your account has no assigned role.");
                await logoutUser(); // Security cleanup
            }
        } else {
            console.error("No document found in 'users' collection for this UID.");
            alert("Account exists, but no profile found in database. Contact Admin.");
            await logoutUser();
        }

    } catch (error) {
        console.error("Login Error:", error.code, error.message);
        alert("Error: " + error.message);
    }
}

// --- LOGOUT FUNCTION ---
export async function logoutUser() {
    try {
        await signOut(auth);
        window.location.href = 'index.html';
    } catch (error) {
        console.error("Logout failed", error);
    }
}
