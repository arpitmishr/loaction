// js/salesman.js

// 1. IMPORTS
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, Timestamp, GeoPoint 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

console.log("Script loaded. Waiting for Auth...");

// --- 2. MAIN EXECUTION ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        console.log("No user. Redirecting...");
        window.location.href = 'index.html';
        return;
    }

    console.log("User logged in:", user.uid);

    try {
        // A. Check Role
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (!userDoc.exists()) {
            alert("Error: User profile not found in 'users' collection.");
            return;
        }

        if (userDoc.data().role !== 'salesman') {
            alert("Access Denied: Salesman role required.");
            logoutUser();
            return;
        }

        // B. Show Dashboard
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';

        // C. Load Data
        checkTodayAttendance(user);
        
        // D. Load Route (Critical Step)
        loadAssignedRoute(user.uid);

        // E. Attach Event Listeners
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) checkInBtn.addEventListener('click', () => handleCheckIn(user));

    } catch (error) {
        console.error("Init Error:", error);
        alert("System Error: " + error.message);
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);


// --- 3. ROUTE LOGIC (DEBUGGED) ---

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');
    const debugEl = document.getElementById('route-debug'); // Ensure this element exists in HTML or ignore

    console.log("Looking for route for UID:", uid);
    if(routeNameEl) routeNameEl.innerText = "Searching for Route...";

    try {
        // Query: Find route where assignedSalesmanId == current user ID
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            console.warn("No route document found for this UID.");
            if(routeNameEl) routeNameEl.innerText = "No Route Assigned";
            if(shopsListEl) shopsListEl.innerHTML = "<li style='padding:15px; color:orange;'>Contact Admin to assign a route.</li>";
            return;
        }

        // Route Found
        const routeDoc = routeSnap.docs[0];
        const routeData = routeDoc.data();
        console.log("Route Found:", routeData.name, "ID:", routeDoc.id);

        if(routeNameEl) routeNameEl.innerText = routeData.name;
        
        // Load Outlets for this Route
        loadRouteOutlets(routeDoc.id, uid);

    } catch (error) {
        console.error("Load Route Error:", error);
        if(routeNameEl) routeNameEl.innerText = "Error Loading Route";
        if(shopsListEl) shopsListEl.innerHTML = `<li style="color:red; padding:15px;">Error: ${error.message}</li>`;
    }
}

async function loadRouteOutlets(routeId, uid) {
    const list = document.getElementById('shops-list');
    if(!list) return;
    
    list.innerHTML = '<li>Loading shops...</li>';
    console.log("Loading outlets for Route ID:", routeId);

    try {
        // Query: Get outlets for route, ordered by sequence
        // NOTE: This often fails if Index is missing
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            orderBy("sequence", "asc")
        );
        
        const snap = await getDocs(q);
        
        list.innerHTML = ""; // Clear loading text

        if (snap.empty) {
            console.log("Route has no outlets.");
            list.innerHTML = '<li style="padding:15px;">No shops added to this route yet.</li>';
            return;
        }

        console.log(`Found ${snap.size} outlets.`);

        snap.forEach(doc => {
            const data = doc.data();
            const li = document.createElement('li');
            li.style.cssText = "background:white; margin:10px 0; padding:15px; border-radius:8px; border:1px solid #ddd; display:flex; justify-content:space-between; align-items:center;";

            li.innerHTML = `
                <div>
                    <strong style="font-size:1.1rem;">${data.outletName}</strong>
                    <div style="font-size:0.9rem; color:#666;">Seq: ${data.sequence}</div>
                </div>
                <button class="visit-btn" data-id="${data.outletId}" data-name="${data.outletName}" 
                    style="background:#007bff; color:white; border:none; padding:8px 15px; border-radius:5px; cursor:pointer;">
                    Visit 🚀
                </button>
            `;
            list.appendChild(li);
        });

        // Attach listeners to new buttons
        document.querySelectorAll('.visit-btn').forEach(btn => {
            btn.addEventListener('click', (e) => handleVisit(uid, e.target.dataset.id, e.target.dataset.name, e.target));
        });

    } catch (error) {
        console.error("Load Outlets Error:", error);
        
        // SPECIFIC ERROR MESSAGE FOR MISSING INDEX
        if (error.message.includes("index")) {
            list.innerHTML = `<li style="color:red; font-weight:bold; padding:15px;">
                ⚠️ Database Index Missing.<br>
                1. Open Console (F12)<br>
                2. Click the Firebase Link in Red<br>
                3. Create Index
            </li>`;
        } else {
            list.innerHTML = `<li style="color:red; padding:15px;">Error: ${error.message}</li>`;
        }
    }
}

// --- 4. ACTION LOGIC ---

async function handleVisit(uid, outletId, outletName, btnElement) {
    if(!confirm(`Start visit for ${outletName}?`)) return;

    if (!navigator.geolocation) {
        alert("Geolocation not supported.");
        return;
    }

    btnElement.disabled = true;
    btnElement.innerText = "Locating...";

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            try {
                await addDoc(collection(db, "visits"), {
                    salesmanId: uid,
                    outletId: outletId,
                    outletName: outletName,
                    checkInTime: Timestamp.now(),
                    location: new GeoPoint(pos.coords.latitude, pos.coords.longitude),
                    type: "routine_visit"
                });

                alert("Visit Started! ✅");
                btnElement.innerText = "Visited";
                btnElement.style.background = "#28a745";

            } catch (error) {
                console.error("Visit Error:", error);
                alert("Failed: " + error.message);
                btnElement.disabled = false;
                btnElement.innerText = "Visit 🚀";
            }
        },
        (err) => {
            alert("Location required.");
            btnElement.disabled = false;
            btnElement.innerText = "Visit 🚀";
        }
    );
}

// --- 5. ATTENDANCE LOGIC ---

function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, '0') + "-" + String(d.getDate()).padStart(2, '0');
}

async function checkTodayAttendance(user) {
    const statusEl = document.getElementById('attendance-status');
    const btn = document.getElementById('checkInBtn');
    if(!statusEl) return;

    try {
        const todayStr = getTodayDateString();
        const q = query(collection(db, "attendance"), where("salesmanId", "==", user.uid), where("date", "==", todayStr));
        const snap = await getDocs(q);

        if (!snap.empty) {
            const data = snap.docs[0].data();
            const time = data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            statusEl.innerHTML = `✅ Checked in at <b>${time}</b>`;
            statusEl.style.color = "green";
            if(btn) { btn.innerText = "Attendance Marked"; btn.disabled = true; }
        } else {
            statusEl.innerText = "You haven't checked in today.";
            if(btn) btn.disabled = false;
        }
    } catch (e) { 
        console.error("Attendance Error:", e);
        if(e.message.includes("index")) console.warn("Missing Index for Attendance");
    }
}

function handleCheckIn(user) {
    const btn = document.getElementById('checkInBtn');
    if (!navigator.geolocation) return alert("No GPS");
    btn.innerText = "Locating...";
    navigator.geolocation.getCurrentPosition(async (pos) => {
        try {
            await addDoc(collection(db, "attendance"), {
                salesmanId: user.uid,
                salesmanEmail: user.email,
                date: getTodayDateString(),
                checkInTime: Timestamp.now(),
                location: new GeoPoint(pos.coords.latitude, pos.coords.longitude)
            });
            alert("Checked In!");
            checkTodayAttendance(user);
        } catch (e) { 
            alert("Error: " + e.message); 
            btn.innerText = "Check In"; 
        }
    });
}
