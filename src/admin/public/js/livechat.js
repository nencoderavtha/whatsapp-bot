import { api } from "./api.js";
import { showToast, esc } from "./utils.js";

let selectedCustomerId = null;
let activeConversations = [];

export function getSelectedCustomerId() { return selectedCustomerId; }

export async function loadChatThreads() {
  const cs = await api("/customers");
  activeConversations = cs;
  const el = document.getElementById("chat-threads");
  document.getElementById("chat-count").textContent = cs.length;
  if (!cs.length) {
    el.innerHTML = '<div class="p-6 text-center text-slate-500 text-xs">No contacts yet</div>';
    return;
  }
  el.innerHTML = cs.map(c => {
    const active = selectedCustomerId === c.id;
    return `
      <div onclick="window.selectConversation(${c.id})"
        class="p-3.5 flex items-center gap-3 cursor-pointer hover:bg-slate-900/30 transition-all ${active ? "bg-slate-900 border-l-2 border-rose-500" : ""}">
        <div class="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center font-bold text-xs text-slate-400">
          ${c.name ? c.name[0].toUpperCase() : "?"}
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-bold text-xs truncate text-slate-200">${esc(c.name) || "(No Name)"}</div>
          <p class="text-[10px] text-slate-400 font-mono truncate mt-0.5">${c.phone}</p>
        </div>
        <span class="text-[10px] bg-slate-900 border border-slate-800 text-slate-400 px-1.5 py-0.5 rounded">${c._count.orders}ord</span>
      </div>`;
  }).join("");
}

export async function selectConversation(id) {
  selectedCustomerId = id;
  loadChatThreads();
  const c = activeConversations.find(x => x.id === id);
  if (!c) return;
  loadCustomerProfile(c);
  document.getElementById("chat-title").textContent = c.name || "(Unknown)";
  document.getElementById("chat-subtitle").textContent = c.phone;
  document.getElementById("chat-avatar").textContent = c.name ? c.name[0].toUpperCase() : "?";

  const el = document.getElementById("chat-messages");
  el.innerHTML = '<div class="text-center text-xs text-slate-500 py-12">Loading...</div>';
  try {
    const msgs = await api(`/customers/${id}/messages`);
    el.innerHTML = msgs.length
      ? msgs.map(m => chatBubble(m)).join("")
      : '<div class="text-center text-xs text-slate-500 py-12">No chat history</div>';
    scrollToBottom();
  } catch (e) {
    el.innerHTML = '<div class="text-center text-xs text-rose-400 py-12">Failed to load</div>';
  }
}

export function appendChatMessage(m) {
  if (m.customerId !== selectedCustomerId) return;
  const el = document.getElementById("chat-messages");
  if (el.querySelector(".py-12")) el.innerHTML = "";
  el.insertAdjacentHTML("beforeend", chatBubble(m));
  scrollToBottom();
}

function chatBubble(m) {
  const u = m.role === "user";
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return `
    <div class="flex ${u ? "justify-end" : "justify-start"} w-full">
      <div class="max-w-[75%] p-3.5 rounded-2xl shadow-sm ${u ? "bg-rose-600 text-white rounded-tr-none" : "bg-slate-900 border border-slate-800 text-slate-100 rounded-tl-none"}">
        <p class="text-xs leading-relaxed whitespace-pre-wrap">${esc(m.content)}</p>
        <div class="text-[9px] mt-1 text-right text-slate-400 select-none">${time}</div>
      </div>
    </div>`;
}

function scrollToBottom() {
  const el = document.getElementById("chat-messages");
  setTimeout(() => { el.scrollTop = el.scrollHeight; }, 50);
}

export function loadCustomerProfile(c) {
  document.getElementById("no-profile-selected").classList.add("hidden");
  document.getElementById("profile-details").classList.remove("hidden");
  document.getElementById("cust-id").value = c.id;
  document.getElementById("cust-phone").textContent = c.phone;
  document.getElementById("cust-name").value = c.name || "";
  document.getElementById("cust-address").value = c.address || "";
  document.getElementById("cust-notes").value = c.notes || "";
}

export async function saveCustProfile() {
  const id = document.getElementById("cust-id").value;
  try {
    await api(`/customers/${id}`, {
      method: "PUT",
      body: JSON.stringify({
        name: document.getElementById("cust-name").value.trim(),
        address: document.getElementById("cust-address").value.trim(),
        notes: document.getElementById("cust-notes").value.trim(),
      }),
    });
    showToast("Profile Updated", "Customer changes saved.");
  } catch (e) {
    showToast("Error", "Could not save profile.");
  }
}
