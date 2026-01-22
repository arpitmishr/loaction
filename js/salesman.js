// js/salesman.js
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, Timestamp, GeoPoint } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

console.log("Salesman.js loaded"); // Debug 1

onAuthStateChanged(auth, async (user) => {
    if (!user) {
        console.log("No user found, redirecting...");
        window.location.href = 'index.html';
        return;
    }

    console.log("User found:", user.uid); // Debug 2

    try {
        // 1. Check User Role
        const userDocRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userDocRef);

        if (!userDoc.exists()) {
            console.error("FATAL: User document missing in Firestore 'users' collection");
            alert("Account exists in Auth, but not in Database. Contact Admin.");
            logoutUser();
            return;
        }

        const userData = userDoc.data();
        console.log("User Role in DB:", userData.role); // Debug 3

        if (userData.role !== 'salesman') {
            alert("Access Denied: You are not a Salesman. Your role is: " + userData.role);
            logoutUser();
            return;
        }

        // 2. SUCCESS: Show Content
        if (loader) loader.style.display = 'none';
        content.style.display = 'block';

        // 3. Load Data (Attendance & Route)
        // We run these independently so if one fails, the dashboard still loads
        checkTodayAttendance(user);
        loadAssignedRoute(user.uid);

        // 4. Attach Event Listener for Check-in
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) {
            checkInBtn.addEventListener('click', () => handleCheckIn(user));
        }

    } catch (error) {
        console.error("Error during initialization:", error);
        alert("System Error: Check Console for details.");
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);

// --- 1. ATTENDANCE LOGIC ---

function getTodayDateString() {
    const d = new Date();
    return d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');
}

async function checkTodayAttendance(user) {
    const statusEl = document.getElementById('attendance-status');
    const btn = document.getElementById('checkInBtn');
    if(!statusEl) return;

    try {
        const todayStr = getTodayDateString();
        // Query requires Index: collection 'attendance', fields: salesmanId (ASC), date (ASC)
        const q = query(
            collection(db, "attendance"),
            where("salesmanId", "==", user.uid),
            where("date", "==", todayStr)
        );

        const snap = await getDocs(q);

        if (!snap.empty) {
            const data = snap.docs[0].data();
            const time = data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            statusEl.innerHTML = `✅ Checked in at <b>${time}</b>`;
            statusEl.style.color = "green";
            if(btn) {
                btn.innerText = "Attendance Marked";
                btn.disabled = true;
            }
        } else {
            statusEl.innerText = "You haven't checked in today.";
            if(btn) btn.disabled = false;
        }
    } catch (error) {
        console.error("Attendance Check Error:", error);
        if(error.message.includes("index")) {
             console.warn("👉 CLICK THE LINK IN CONSOLE TO CREATE INDEX 👈");
        }
    }
}

function handleCheckIn(user) {
    const btn = document.getElementById('checkInBtn');
    if (!navigator.geolocation) {
        alert("Geolocation not supported.");
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

                await addDoc(collection(db, "attendance"), {
                    salesmanId: user.uid,
                    salesmanEmail: user.email,
                    date: todayStr,
                    checkInTime: Timestamp.now(),
                    location: new GeoPoint(lat, lng)
                });

                alert("Check-in Successful!");
                checkTodayAttendance(user);
            } catch (error) {
                console.error("Check-in Error:", error);
                alert("Failed to save: " + error.message);
                btn.disabled = false;
            }
        },
        (error) => {
            alert("Location access required.");
            btn.innerText = "Retry Check In";
            btn.disabled = false;
        }
    );
}

// --- 2. ROUTE LOGIC ---

async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');
    if(!routeNameEl) return;

    try {
        const q = query(collection(db, "routes"), where("assignedSalesmanId", "==", uid));
        const routeSnap = await getDocs(q);

        if (routeSnap.empty) {
            routeNameEl.innerText = "No route assigned.";
            shopsListEl.innerHTML = "<li>Contact Admin.</li>";
            return;
        }

        const routeDoc = routeSnap.docs[0];
        routeNameEl.innerText = routeDoc.data().name;
        loadRouteOutlets(routeDoc.id);

    } catch (error) {
        console.error("Route Error:", error);
        routeNameEl.innerText = "Error loading route.";
    }
}

async function loadRouteOutlets(routeId) {
    const list = document.getElementById('shops-list');
    
    try {
        // Query requires Index: collection 'route_outlets', fields: routeId (ASC), sequence (ASC)
        const q = query(
            collection(db, "route_outlets"), 
            where("routeId", "==", routeId),
            orderBy("sequence", "asc") 
        );
        
        const snap = await getDocs(q);
        list.innerHTML = '';

        if (snap.empty) {
            list.innerHTML = '<li>No shops in this route.</li>';
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const li = document.createElement('li');
            li.innerHTML = `
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong>${data.outletName}</strong>
                        <div style="font-size:12px; color:#666;">Seq: ${data.sequence}</div>
                    </div>
                </div>
            `;
            li.style.borderBottom = "1px solid #eee";
            li.style.padding = "10px";
            list.appendChild(li);
        });

    } catch (error) {
        console.error("Outlets Error:", error);
        if(error.message.includes("index")) {
             console.warn("👉 CLICK THE LINK IN CONSOLE TO CREATE INDEX FOR OUTLETS 👈");
        }
        list.innerHTML = '<li>Error loading shops.</li>';
    }
}
