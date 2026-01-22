// js/salesman.js
import { 
    collection, addDoc, query, where, getDocs, Timestamp, GeoPoint 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, getDocs, orderBy } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'salesman') {
        alert("Access Denied");
        logoutUser();
        return;
    }

    if(loader) loader.style.display = 'none';
    content.style.display = 'block';

    // Load the Route
    loadAssignedRoute(user.uid);
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');

    try {
        // 1. Find the route assigned to this user
        // Note: In a real app, you might also filter by 'active: true' or weekDay
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            routeNameEl.innerText = "No route assigned.";
            shopsListEl.innerHTML = "<li>Contact Admin to assign a route.</li>";
            return;
        }

        // Assuming 1 salesman has 1 active route for simplicity
        const routeDoc = routeSnap.docs[0]; 
        const routeData = routeDoc.data();
        const routeId = routeDoc.id;

        routeNameEl.innerText = routeData.name; // Display Route Name

        // 2. Load Outlets for this Route (using route_outlets collection)
        loadRouteOutlets(routeId);

    } catch (error) {
        console.error("Error fetching route:", error);
        routeNameEl.innerText = "Error loading route.";
    }
}

async function loadRouteOutlets(routeId) {
    const list = document.getElementById('shops-list');
    list.innerHTML = '<li>Loading shops...</li>';

    try {
        // Query route_outlets where routeId matches
        // We order by 'sequence' so shops appear in visit order
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            orderBy("sequence", "asc") 
        );
        
        const snap = await getDocs(q);
        list.innerHTML = ''; // Clear loading

        if (snap.empty) {
            list.innerHTML = '<li>No shops found in this route.</li>';
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const li = document.createElement('li');
            li.innerHTML = `
                <strong>${data.outletName}</strong><br>
                <small>Sequence: ${data.sequence}</small>
                <button onclick="alert('Visit logic coming soon!')">Check In</button>
            `;
            li.style.borderBottom = "1px solid #eee";
            li.style.padding = "10px 0";
            list.appendChild(li);
        });

    } catch (error) {
        console.error("Error loading outlets:", error);
        // Sometimes Firestore requires an Index for filtering + sorting. 
        // If this errors, check Console for a link to create the index.
        list.innerHTML = '<li>Error loading shops (Check Console).</li>';
    }
}
