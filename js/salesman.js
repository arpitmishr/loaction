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

    if (loader) loader.style.display = 'none';
    content.style.display = 'block';

    // ✅ Check today's attendance AFTER login & role validation
    await checkTodayAttendance(user);

    // Load assigned route
    loadAssignedRoute(user.uid);

    // ✅ Attach event listener INSIDE auth block
    document
        .getElementById('checkInBtn')
        .addEventListener('click', () => handleCheckIn(user));
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




// --- ATTENDANCE LOGIC ---

function getTodayDateString() {
    // Returns "YYYY-MM-DD" based on local time
    const d = new Date();
    return d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');
}

async function checkTodayAttendance(user) {
    const statusEl = document.getElementById('attendance-status');
    const btn = document.getElementById('checkInBtn');
    const todayStr = getTodayDateString();

    try {
        // Query: Find attendance docs for THIS user + THIS date
        const q = query(
            collection(db, "attendance"),
            where("salesmanId", "==", user.uid),
            where("date", "==", todayStr)
        );

        const snap = await getDocs(q);

        if (!snap.empty) {
            // Already checked in
            const data = snap.docs[0].data();
            const time = data.checkInTime.toDate().toLocaleTimeString();
            statusEl.innerHTML = `✅ Checked in at <b>${time}</b>`;
            statusEl.style.color = "green";
            btn.innerText = "Attendance Marked";
            btn.disabled = true;
        } else {
            // Not checked in yet
            statusEl.innerText = "You haven't checked in today.";
            btn.disabled = false;
        }
    } catch (error) {
        console.error("Error checking attendance:", error);
        statusEl.innerText = "Error loading status.";
    }
}

function handleCheckIn(user) {
    const btn = document.getElementById('checkInBtn');
    const statusEl = document.getElementById('attendance-status');

    if (!navigator.geolocation) {
        alert("Geolocation is not supported by your browser.");
        return;
    }

    btn.innerText = "Locating...";
    btn.disabled = true;

    navigator.geolocation.getCurrentPosition(
        async (position) => {
            try {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                const todayStr = getTodayDateString();

                // Create the Record
                await addDoc(collection(db, "attendance"), {
                    salesmanId: user.uid,
                    salesmanEmail: user.email, // Storing email saves a read query later
                    date: todayStr,
                    checkInTime: Timestamp.now(),
                    location: new GeoPoint(lat, lng),
                    device: navigator.userAgent // Optional: Track device info
                });

                // UI Update
                alert("Check-in Successful!");
                checkTodayAttendance(user); // Refresh UI

            } catch (error) {
                console.error("Firestore Error:", error);
                alert("Failed to save attendance. Try again.");
                btn.disabled = false;
                btn.innerText = "📍 Check In Now";
            }
        },
        (error) => {
            // Location Error Handling
            console.error("Geo Error:", error);
            let msg = "Location error.";
            if(error.code === 1) msg = "Please allow location access to check in.";
            if(error.code === 2) msg = "Location unavailable. GPS signal lost.";
            if(error.code === 3) msg = "Location request timed out.";
            
            alert(msg);
            statusEl.innerText = msg;
            statusEl.style.color = "red";
            btn.disabled = false;
            btn.innerText = "📍 Check In Now";
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}
