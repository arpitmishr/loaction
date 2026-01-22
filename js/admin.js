// js/admin.js
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc, collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader'); // Ensure you have a loader div in HTML

// 1. Auth Guard
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'admin') {
        alert("Access Denied");
        logoutUser();
        return;
    }

    // Show Dashboard
    if(loader) loader.style.display = 'none';
    content.style.display = 'block';

    // 2. Load Data
    loadSalesmen();
    loadProducts();
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);

// --- FUNCTIONS TO FETCH DATA ---

async function loadSalesmen() {
    const list = document.getElementById('salesmen-list');
    list.innerHTML = ''; // Clear loading text

    try {
        // Query users where role == 'salesman'
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const querySnapshot = await getDocs(q);

        if (querySnapshot.empty) {
            list.innerHTML = '<li>No salesmen found.</li>';
            return;
        }

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const li = document.createElement('li');
            // Display Name and Phone
            li.textContent = `${data.fullName || data.email} (${data.phone || 'No Phone'})`;
            list.appendChild(li);
        });
    } catch (error) {
        console.error("Error loading salesmen:", error);
        list.innerHTML = '<li>Error loading data.</li>';
    }
}

async function loadProducts() {
    const list = document.getElementById('product-list');
    list.innerHTML = '';

    try {
        const querySnapshot = await getDocs(collection(db, "products"));
        
        if (querySnapshot.empty) {
            list.innerHTML = '<li>No products in inventory.</li>';
            return;
        }

        querySnapshot.forEach((doc) => {
            const data = doc.data();
            const li = document.createElement('li');
            li.textContent = `${data.name} - $${data.price} (Stock: ${data.stockQty})`;
            list.appendChild(li);
        });
    } catch (error) {
        console.error("Error loading products:", error);
    }
}
