import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, getDocs, orderBy, addDoc, Timestamp, GeoPoint } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- AUTH & INIT ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (!userDoc.exists() || userDoc.data().role !== 'salesman') {
            alert("Access Denied: Salesman only.");
            logoutUser();
            return;
        }

        // Show Dashboard
        if (loader) loader.style.display = 'none';
        content.style.display = 'block';

        // Load Data
        checkTodayAttendance(user);
        loadAssignedRoute(user.uid);

        // Attach Check-in Button
        const checkInBtn = document.getElementById('checkInBtn');
        if(checkInBtn) {
            checkInBtn.addEventListener('click', () => handleCheckIn(user));
        }

    } catch (error) {
        console.error("Init Error:", error);
        alert("Error loading profile: " + error.message);
    }
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);

// --- ATTENDANCE FUNCTIONS ---

function getTodayDateString() {
    const d = new Date();
    // Format: YYYY-MM-DD
    return d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');
}

async function checkTodayAttendance(user) {
    const statusEl = document.getElementById('attendance-status');
    const btn = document.getElementById('checkInBtn');
    
    try {
        const todayStr = getTodayDateString();
        
        // QUERY: Get attendance for THIS user for THIS date
        // NOTE: This requires a composite index in Firestore!
        const q = query(
            collection(db, "attendance"),
            where("salesmanId", "==", user.uid),
            where("date", "==", todayStr)
        );

        const snap = await getDocs(q);

        if (!snap.empty) {
            // Already checked in
            const data = snap.docs[0].data();
            const time = data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
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
        console.error("Attendance Error:", error);
        
        // SHOW ERROR ON SCREEN
        if(error.message.includes("index")) {
            statusEl.innerHTML = `<span style="color:red; font-weight:bold;">⚠️ Missing Index</span><br>Open Console (F12) & Click the Firebase Link.`;
        } else {
            statusEl.innerText = "Error: " + error.message;
            statusEl.style.color = "red";
        }
    }
}

function handleCheckIn(user) {
    const btn = document.getElementById('checkInBtn');
    const statusEl = document.getElementById('attendance-status');

    // 1. Check if Geolocation exists
    if (!navigator.geolocation) {
        alert("Your browser does not support Geolocation.");
        return;
    }

    // 2. Check for Secure Context (HTTPS)
    if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
        alert("Location requires HTTPS. Please host on GitHub Pages or use localhost.");
        return;
    }

    btn.innerText = "Locating...";
    btn.disabled = true;

    // 3. Request Location
    navigator.geolocation.getCurrentPosition(
        async (position) => {
            // SUCCESS
            try {
                btn.innerText = "Saving...";
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                const todayStr = getTodayDateString();

                await addDoc(collection(db, "attendance"), {
                    salesmanId: user.uid,
                    salesmanEmail: user.email,
                    date: todayStr,
                    checkInTime: Timestamp.now(),
                    location: new GeoPoint(lat, lng),
                    device: navigator.userAgent
                });

                alert("Check-in Successful!");
                checkTodayAttendance(user); // Refresh UI

            } catch (error) {
                console.error("Save Error:", error);
                alert("Database Error: " + error.message);
                btn.innerText = "📍 Check In Now";
                btn.disabled = false;
            }
        },
        (error) => {
            // ERROR / PERMISSION DENIED
            console.error("Geo Error:", error);
            
            let msg = "Unknown location error.";
            switch(error.code) {
                case error.PERMISSION_DENIED:
                    msg = "❌ Permission Denied. Please allow location access in browser settings.";
                    break;
                case error.POSITION_UNAVAILABLE:
                    msg = "❌ GPS Signal unavailable.";
                    break;
                case error.TIMEOUT:
                    msg = "❌ Location request timed out.";
                    break;
            }

            statusEl.innerHTML = `<span style="color:red">${msg}</span>`;
            alert(msg);
            btn.innerText = "📍 Check In Now";
            btn.disabled = false;
        },
        { 
            enableHighAccuracy: true, 
            timeout: 15000, // Wait up to 15 seconds
            maximumAge: 0 
        }
    );
}

// --- ROUTE FUNCTIONS (Keep these as is) ---
async function loadAssignedRoute(uid) {
    const routeNameEl = document.getElementById('route-name');
    const shopsListEl = document.getElementById('shops-list');
    
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
        const q = query(collection(db, "route_outlets"), where("routeId", "==", routeId), orderBy("sequence", "asc"));
        const snap = await getDocs(q);
        list.innerHTML = '';
        if (snap.empty) { list.innerHTML = '<li>No shops.</li>'; return; }
        snap.forEach(doc => {
            const data = doc.data();
            const li = document.createElement('li');
            li.innerHTML = `<strong>${data.outletName}</strong>`;
            li.style.padding = "10px";
            li.style.borderBottom = "1px solid #eee";
            list.appendChild(li);
        });
    } catch (error) {
        console.error("Outlet Error:", error);
        list.innerHTML = '<li>Error loading shops (Index missing?).</li>';
    }
}
