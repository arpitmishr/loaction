// js/admin.js

// 1. Consolidated Imports
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, orderBy 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- 2. Main Execution (Auth Guard) ---
onAuthStateChanged(auth, async (user) => {
    // A. Not Logged In -> Redirect
    if (!user) {
        window.location.href = 'index.html';
        return;
    }

    try {
        // B. Check Admin Role
        const userDoc = await getDoc(doc(db, "users", user.uid));
        
        if (!userDoc.exists() || userDoc.data().role !== 'admin') {
            alert("Access Denied: Admins Only.");
            await logoutUser();
            return;
        }

        // C. SUCCESS: Hide Loader & Show Content
        if (loader) loader.style.display = 'none';
        if (content) content.style.display = 'block';
        
        if(document.getElementById('user-email')) {
            document.getElementById('user-email').innerText = user.email;
        }

        // D. Load Data (After UI is visible)
        // We run these separately so one failure doesn't stop the others
        loadDashboardStats();
        loadTodayAttendance();
        loadOutlets(); 
        loadSalesmenList();
        
        // E. Setup Forms
        setupOutletForm();

    } catch (error) {
        console.error("Dashboard Init Error:", error);
        if (loader) loader.innerText = "Error loading dashboard. Check console.";
        alert("Error: " + error.message);
    }
});

// Logout Listener
const logoutBtn = document.getElementById('logoutBtn');
if (logoutBtn) logoutBtn.addEventListener('click', logoutUser);


// --- 3. CORE DASHBOARD LOGIC ---

async function loadDashboardStats() {
    try {
        // Define "Today"
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        const startTs = Timestamp.fromDate(startOfDay);
        const endTs = Timestamp.fromDate(endOfDay);

        // Execute Queries
        // Note: These might require indexes. Check Console if data is missing.
        const [attendanceSnap, ordersSnap, outletsSnap] = await Promise.all([
            getDocs(query(collection(db, "attendance"), where("checkInTime", ">=", startTs), where("checkInTime", "<", endTs))),
            getDocs(query(collection(db, "orders"), where("orderDate", ">=", startTs), where("orderDate", "<", endTs))),
            getDocs(collection(db, "outlets"))
        ]);

        // Calculate Stats
        const attendanceCount = attendanceSnap.size;
        let totalOrders = ordersSnap.size;
        let totalSales = 0;
        
        ordersSnap.forEach(doc => {
            totalSales += Number(doc.data().totalAmount) || 0;
        });

        let totalCredit = 0;
        outletsSnap.forEach(doc => {
            totalCredit += Number(doc.data().currentBalance) || 0;
        });

        // Update UI (Check if elements exist first)
        const elAttend = document.getElementById('stat-attendance');
        const elOrders = document.getElementById('stat-orders');
        const elSales = document.getElementById('stat-sales');
        const elCredit = document.getElementById('stat-credit');

        if(elAttend) elAttend.innerText = attendanceCount;
        if(elOrders) elOrders.innerText = totalOrders;
        if(elSales) elSales.innerText = formatCurrency(totalSales);
        if(elCredit) elCredit.innerText = formatCurrency(totalCredit);

    } catch (error) {
        console.error("Error loading stats (Likely missing Index):", error);
    }
}

async function loadTodayAttendance() {
    const list = document.getElementById('attendance-list');
    if (!list) return;

    const d = new Date();
    const todayStr = d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');

    try {
        const q = query(
            collection(db, "attendance"),
            where("date", "==", todayStr),
            orderBy("checkInTime", "desc")
        );

        const snap = await getDocs(q);
        list.innerHTML = "";

        if (snap.empty) {
            list.innerHTML = "<tr><td colspan='3' style='padding:15px; text-align:center'>No check-ins today.</td></tr>";
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime ? data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : 'N/A';
            
            // Handle missing location safely
            let mapLink = "No Loc";
            if (data.location) {
                const lat = data.location.latitude;
                const lng = data.location.longitude;
                mapLink = `<a href="https://www.google.com/maps/search/?api=1&query=${lat},${lng}" target="_blank" style="color: #007bff; text-decoration: none;">View 📍</a>`;
            }

            const row = `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 10px;">${data.salesmanEmail || 'Unknown'}</td>
                    <td>${time}</td>
                    <td>${mapLink}</td>
                </tr>
            `;
            list.innerHTML += row;
        });

    } catch (error) {
        console.error("Attendance Load Error:", error);
        if(error.message.includes("index")) {
            list.innerHTML = "<tr><td colspan='3' style='color:red'>Missing Index. Check Console (F12).</td></tr>";
        }
    }
}

// --- 4. OUTLET MANAGEMENT ---

function setupOutletForm() {
    const form = document.getElementById('addOutletForm');
    const geoBtn = document.getElementById('geoBtn');
    
    if (!form || !geoBtn) return; // Prevent error if elements don't exist

    // Handle Geolocation
    geoBtn.addEventListener('click', () => {
        const display = document.getElementById('geoDisplay');
        const btn = document.getElementById('geoBtn');

        if (!navigator.geolocation) {
            alert("Geolocation not supported");
            return;
        }

        btn.innerText = "Locating...";
        
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                document.getElementById('lat').value = pos.coords.latitude;
                document.getElementById('lng').value = pos.coords.longitude;
                display.innerText = `Lat: ${pos.coords.latitude.toFixed(4)}, Lng: ${pos.coords.longitude.toFixed(4)}`;
                display.style.color = "green";
                btn.innerText = "📍 Location Captured";
            },
            (err) => {
                console.error(err);
                alert("Could not get location.");
                btn.innerText = "Retry GPS";
            }
        );
    });

    // Handle Submit
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const submitBtn = e.target.querySelector('button[type="submit"]');
        submitBtn.disabled = true;
        submitBtn.innerText = "Saving...";

        const lat = document.getElementById('lat').value;
        const lng = document.getElementById('lng').value;

        if (!lat || !lng) {
            alert("Please click 'Get GPS Location' first.");
            submitBtn.disabled = false;
            submitBtn.innerText = "Save Outlet";
            return;
        }

        try {
            await addDoc(collection(db, "outlets"), {
                shopName: document.getElementById('shopName').value,
                ownerName: document.getElementById('ownerName').value,
                phone: document.getElementById('shopPhone').value,
                category: document.getElementById('shopCategory').value,
                geo: { lat: parseFloat(lat), lng: parseFloat(lng) },
                status: 'active',
                currentBalance: 0,
                createdAt: serverTimestamp()
            });

            alert("Outlet Added Successfully!");
            form.reset();
            document.getElementById('geoDisplay').innerText = "No location captured";
            document.getElementById('geoBtn').innerText = "📍 Get GPS Location";
            document.getElementById('lat').value = "";
            document.getElementById('lng').value = "";
            
            loadOutlets();

        } catch (error) {
            console.error("Add Outlet Error:", error);
            alert("Error: " + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Save Outlet";
        }
    });
}

async function loadOutlets() {
    const tableBody = document.getElementById('outlets-table-body');
    if (!tableBody) return;
    
    try {
        // Simple query. If you want order, use: query(collection(db, "outlets"), orderBy("createdAt", "desc"));
        // Note: orderBy requires an index if mixed with filters later
        const q = query(collection(db, "outlets")); 
        const snap = await getDocs(q);

        tableBody.innerHTML = "";

        if (snap.empty) {
            tableBody.innerHTML = "<tr><td colspan='5'>No outlets found.</td></tr>";
            return;
        }

        snap.forEach(docSnap => {
            const data = docSnap.data();
            const id = docSnap.id;
            const isBlocked = data.status === 'blocked';
            
            const statusBadge = isBlocked 
                ? `<span class="badge badge-blocked" style="background:#f8d7da; color:#721c24; padding:5px 10px; border-radius:20px;">Blocked</span>` 
                : `<span class="badge badge-active" style="background:#d4edda; color:#155724; padding:5px 10px; border-radius:20px;">Active</span>`;

            const actionBtn = isBlocked
                ? `<button style="background:#28a745; color:white; border:none; padding:5px; border-radius:4px; cursor:pointer;" onclick="toggleOutletStatus('${id}', 'active')">Unblock</button>`
                : `<button style="background:#dc3545; color:white; border:none; padding:5px; border-radius:4px; cursor:pointer;" onclick="toggleOutletStatus('${id}', 'blocked')">Block</button>`;

            const row = `
                <tr>
                    <td><strong>${data.shopName}</strong><br><small>${data.ownerName}</small></td>
                    <td>${data.category}</td>
                    <td><a href="tel:${data.phone}">${data.phone}</a></td>
                    <td>${statusBadge}</td>
                    <td>${actionBtn}</td>
                </tr>
            `;
            tableBody.innerHTML += row;
        });

    } catch (error) {
        console.error("Load Outlets Error:", error);
        tableBody.innerHTML = "<tr><td colspan='5'>Error loading data.</td></tr>";
    }
}

async function loadSalesmenList() {
    const list = document.getElementById('salesmen-list');
    if(!list) return;
    list.innerHTML = '';

    try {
        const q = query(collection(db, "users"), where("role", "==", "salesman"));
        const snap = await getDocs(q);
        
        if(snap.empty) { list.innerHTML = "<li>No salesmen found.</li>"; return; }

        snap.forEach(doc => {
            const d = doc.data();
            const li = document.createElement('li');
            li.textContent = `👤 ${d.fullName || d.email}`;
            list.appendChild(li);
        });
    } catch (e) {
        console.error(e);
    }
}

// Utility: Format Number
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
    }).format(amount);
}

// Global function for buttons
window.toggleOutletStatus = async function(id, newStatus) {
    if(!confirm(`Change status to ${newStatus}?`)) return;
    try {
        await updateDoc(doc(db, "outlets", id), { status: newStatus });
        loadOutlets();
    } catch (error) {
        alert("Failed to update status.");
    }
};
