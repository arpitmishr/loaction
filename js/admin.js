import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp, 
    addDoc, updateDoc, serverTimestamp, orderBy // <--- Added these
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { orderBy } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.2.0/firebase-auth.js";
import { 
    doc, getDoc, collection, getDocs, query, where, Timestamp 
} from "https://www.gstatic.com/firebasejs/11.2.0/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { logoutUser } from "./auth.js";

const content = document.getElementById('content');
const loader = document.getElementById('loader');

// --- 1. Auth Guard ---
onAuthStateChanged(auth, async (user) => {
    if (!user) {
        window.location.href = 'index.html';
        return;
    }
    loadTodayAttendance();

    const userDoc = await getDoc(doc(db, "users", user.uid));
    if (!userDoc.exists() || userDoc.data().role !== 'admin') {
        alert("Access Denied");
        logoutUser();
        return;
    }

    if(loader) loader.style.display = 'none';
    content.style.display = 'block';
    if(document.getElementById('user-email')) 
        document.getElementById('user-email').innerText = user.email;

    // --- 2. Load Data ---
    loadDashboardStats();
    loadOutlets(); 
    setupOutletForm();
    loadSalesmenList(); // Your existing function
});

document.getElementById('logoutBtn').addEventListener('click', logoutUser);


// --- CORE DASHBOARD LOGIC ---

async function loadDashboardStats() {
    try {
        // A. Define "Today" time range
        const now = new Date();
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);

        const startTs = Timestamp.fromDate(startOfDay);
        const endTs = Timestamp.fromDate(endOfDay);

        // B. Execute Queries in Parallel (Faster)
        const [attendanceSnap, ordersSnap, outletsSnap] = await Promise.all([
            // 1. Get Attendance for today
            getDocs(query(
                collection(db, "attendance"),
                where("checkInTime", ">=", startTs),
                where("checkInTime", "<", endTs)
            )),
            // 2. Get Orders for today
            getDocs(query(
                collection(db, "orders"),
                where("orderDate", ">=", startTs),
                where("orderDate", "<", endTs)
            )),
            // 3. Get ALL Outlets (for credit sum)
            getDocs(collection(db, "outlets"))
        ]);

        // C. Process 1: Attendance Count
        const attendanceCount = attendanceSnap.size;

        // D. Process 2: Sales & Orders
        let totalOrders = ordersSnap.size;
        let totalSales = 0;
        
        ordersSnap.forEach(doc => {
            const data = doc.data();
            // Ensure we handle strings or numbers safely
            totalSales += Number(data.totalAmount) || 0;
        });

        // E. Process 3: Outstanding Credit
        let totalCredit = 0;
        outletsSnap.forEach(doc => {
            const data = doc.data();
            // Assuming positive balance means they owe us money
            totalCredit += Number(data.currentBalance) || 0;
        });

        // F. Update UI
        document.getElementById('stat-attendance').innerText = attendanceCount;
        document.getElementById('stat-orders').innerText = totalOrders;
        document.getElementById('stat-sales').innerText = formatCurrency(totalSales);
        document.getElementById('stat-credit').innerText = formatCurrency(totalCredit);

    } catch (error) {
        console.error("Error loading stats:", error);
    }
}

// Utility: Format Number as Currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD' // Change to 'INR' for Rupees
    }).format(amount);
}

// Your existing list function (kept for reference)
async function loadSalesmenList() {
    const list = document.getElementById('salesmen-list');
    if(!list) return;
    list.innerHTML = '';

    const q = query(collection(db, "users"), where("role", "==", "salesman"));
    const snap = await getDocs(q);
    
    if(snap.empty) { list.innerHTML = "<li>No salesmen found.</li>"; return; }

    snap.forEach(doc => {
        const d = doc.data();
        const li = document.createElement('li');
        li.textContent = `👤 ${d.fullName || d.email}`;
        list.appendChild(li);
    });
}


async function loadTodayAttendance() {
    const list = document.getElementById('attendance-list');
    
    // Helper to get today's YYYY-MM-DD
    const d = new Date();
    const todayStr = d.getFullYear() + "-" + 
           String(d.getMonth() + 1).padStart(2, '0') + "-" + 
           String(d.getDate()).padStart(2, '0');

    try {
        // Query: Date == Today
        const q = query(
            collection(db, "attendance"),
            where("date", "==", todayStr),
            orderBy("checkInTime", "desc") // Show newest first
        );

        const snap = await getDocs(q);
        list.innerHTML = "";

        if (snap.empty) {
            list.innerHTML = "<tr><td colspan='3' style='padding:15px; text-align:center'>No check-ins yet today.</td></tr>";
            return;
        }

        snap.forEach(doc => {
            const data = doc.data();
            const time = data.checkInTime.toDate().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
            
            // Create Google Maps Link
            const lat = data.location.latitude;
            const lng = data.location.longitude;
            const mapUrl = `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

            const row = `
                <tr style="border-bottom: 1px solid #eee;">
                    <td style="padding: 10px;">${data.salesmanEmail || 'Unknown'}</td>
                    <td>${time}</td>
                    <td><a href="${mapUrl}" target="_blank" style="color: #007bff; text-decoration: none;">View 📍</a></td>
                </tr>
            `;
            list.innerHTML += row;
        });

    } catch (error) {
        console.error("Error loading attendance:", error);
        // If index error, show helpful message
        if(error.message.includes("index")) {
            list.innerHTML = "<tr><td colspan='3' style='color:red'>Missing Index. Check Console.</td></tr>";
        }
    }
}



// --- OUTLET MANAGEMENT FUNCTIONS ---

function setupOutletForm() {
    // 1. Handle Geolocation Click
    document.getElementById('geoBtn').addEventListener('click', () => {
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
                alert("Could not get location. Ensure GPS is on.");
                btn.innerText = "Retry GPS";
            }
        );
    });

    // 2. Handle Form Submit
    document.getElementById('addOutletForm').addEventListener('submit', async (e) => {
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
                status: 'active', // Default status
                currentBalance: 0,
                createdAt: serverTimestamp()
            });

            alert("Outlet Added Successfully!");
            document.getElementById('addOutletForm').reset();
            document.getElementById('geoDisplay').innerText = "No location captured";
            document.getElementById('geoBtn').innerText = "📍 Get GPS Location";
            
            loadOutlets(); // Refresh list

        } catch (error) {
            console.error("Error adding outlet:", error);
            alert("Error: " + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.innerText = "Save Outlet";
        }
    });
}

async function loadOutlets() {
    const tableBody = document.getElementById('outlets-table-body');
    
    try {
        // Query outlets (Optional: order by createdAt if you create an index)
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
                ? `<span class="badge badge-blocked">Blocked</span>` 
                : `<span class="badge badge-active">Active</span>`;

            const actionBtn = isBlocked
                ? `<button class="btn-sm btn-unblock" onclick="toggleOutletStatus('${id}', 'active')">Unblock</button>`
                : `<button class="btn-sm btn-block" onclick="toggleOutletStatus('${id}', 'blocked')">Block</button>`;

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
        console.error("Error loading outlets:", error);
        tableBody.innerHTML = "<tr><td colspan='5'>Error loading data.</td></tr>";
    }
}

// Make this function global so HTML onclick attributes can see it
window.toggleOutletStatus = async function(id, newStatus) {
    if(!confirm(`Are you sure you want to change status to ${newStatus}?`)) return;

    try {
        const outletRef = doc(db, "outlets", id);
        await updateDoc(outletRef, {
            status: newStatus
        });
        
        // Refresh the list to show new status
        loadOutlets();
    } catch (error) {
        console.error("Error updating status:", error);
        alert("Failed to update status.");
    }
};
