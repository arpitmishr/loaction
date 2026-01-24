// js/auth.js

import { signInWithEmailAndPassword, signOut } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";

// --- GLOBAL APP CACHE ---
export const appCache = {
    user: null // In-memory store
};

// --- HELPER: GET USER (Cache First, Then Network) ---
export async function getCachedUserProfile(uid) {
    // 1. Check Memory (Fastest)
    if (appCache.user && appCache.user.uid === uid) {
        console.log("⚡ Loaded User from Memory");
        return appCache.user;
    }

    // 2. Check Session Storage (Persists across page navigation)
    const stored = sessionStorage.getItem('appUser');
    if (stored) {
        const data = JSON.parse(stored);
        if (data.uid === uid) {
            console.log("💾 Loaded User from Session Storage");
            appCache.user = data; // Hydrate memory
            return data;
        }
    }

    // 3. Network Fetch (Fallback - Only happens once per session)
    console.log("🌐 Fetching User from Firestore...");
    const docSnap = await getDoc(doc(db, "users", uid));
    
    if (docSnap.exists()) {
        const userData = { uid: uid, ...docSnap.data() };
        
        // Save to Caches
        appCache.user = userData;
        sessionStorage.setItem('appUser', JSON.stringify(userData));
        
        return userData;
    } else {
        return null; // User authenticated but no profile doc
    }
}

// --- LOGIN FUNCTION ---
export async function loginUser(email, password) {
    try {
        // 1. Auth with Firebase
        const userCredential = await signInWithEmailAndPassword(auth, email, password);
        const uid = userCredential.user.uid;

        // 2. Fetch & Cache Profile Immediately
        const userData = await getCachedUserProfile(uid);

        if (userData) {
            console.log("Login Success. Role:", userData.role);
            // 3. Redirect
            if (userData.role === 'admin') window.location.href = 'admin.html';
            else if (userData.role === 'salesman') window.location.href = 'salesman.html';
            else {
                alert("No role assigned.");
                await logoutUser();
            }
        } else {
            alert("No profile found.");
            await logoutUser();
        }

    } catch (error) {
        console.error("Login Error:", error);
        alert(error.message);
        throw error; // Re-throw for UI handling
    }
}

// --- LOGOUT FUNCTION ---
export async function logoutUser() {
    try {
        await signOut(auth);
        // Clear all caches
        appCache.user = null;
        sessionStorage.removeItem('appUser');
        sessionStorage.clear(); // Safety clear
        window.location.href = 'index.html';
    } catch (error) {
        console.error("Logout failed", error);
    }
}
