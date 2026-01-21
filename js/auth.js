// js/auth.js
import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

// Login Function
export async function loginUser(email, password) {
    try {
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const user = userCredential.user;
        
        // Check Firestore for the user's role
        // Assumption: You have a collection 'users' where Doc ID = User UID
        const docRef = doc(db, "users", user.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
            const role = docSnap.data().role;
            
            if (role === 'admin') {
                window.location.href = 'admin.html';
            } else if (role === 'salesman') {
                window.location.href = 'salesman.html';
            } else {
                alert("User has no assigned role.");
                await logoutUser();
            }
        } else {
            console.error("No user profile found in Firestore.");
            alert("Login successful, but your account is not set up in the database.");
        }
    } catch (error) {
        console.error("Login Error:", error);
        alert("Login failed: " + error.message);
    }
}

// Logout Function
export async function logoutUser() {
    try {
        await signOut(auth);
        window.location.href = 'index.html';
    } catch (error) {
        console.error("Logout Error:", error);
    }
}
