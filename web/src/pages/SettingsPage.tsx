import type { Account } from "../api";
import { AccountsPage } from "./AccountsPage";
import { ModelsPage } from "./ModelsPage";
import { OrgPage } from "./OrgPage";

export type SettingsTab = "zalo" | "limits" | "reports" | "models" | "org";
export const SETTINGS_TABS: [SettingsTab, string][] = [
  ["zalo", "Kết nối Zalo"],
  ["limits", "Giới hạn & an toàn"],
  ["reports", "Báo cáo & admin"],
  ["models", "Mô hình AI"],
  ["org", "Doanh nghiệp"],
];
/** Tab nào chỉnh riêng cho từng nick Zalo (đổi nick ở ô đầu menu). */
const PER_ACCOUNT: SettingsTab[] = ["zalo", "limits", "reports"];

/** Cài đặt gom một chỗ: mỗi tab một nhóm việc. Ba tab đầu theo nick đang chọn, hai tab sau dùng chung cả app. */
export function SettingsPage({
  tab,
  onTab,
  account,
  accounts,
  onAccountsChanged,
  onAddAccount,
}: {
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  account?: Account;
  accounts: Account[];
  onAccountsChanged: () => Promise<void>;
  onAddAccount: () => Promise<void>;
}) {
  const perAccount = PER_ACCOUNT.includes(tab);
  return (
    <div className="settings">
      <div className="utabs" role="tablist" aria-label="Nhóm cài đặt">
        {SETTINGS_TABS.map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => onTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {perAccount && account && (
        <p className="muted small settings-scope">
          Đang chỉnh cho nick <b>{account.name}</b>
          {accounts.length > 1 ? ". Đổi nick ở ô đầu menu bên trái." : "."}
        </p>
      )}
      {!perAccount && <p className="muted small settings-scope">Dùng chung cho mọi nick Zalo trong app.</p>}
      <div className="settings-body">
        {tab === "zalo" && (
          <AccountsPage key={`z-${account?.id}`} section="connect" account={account} accounts={accounts} onAccountsChanged={onAccountsChanged} onAddAccount={onAddAccount} />
        )}
        {tab === "limits" && (
          <AccountsPage key={`l-${account?.id}`} section="limits" account={account} accounts={accounts} onAccountsChanged={onAccountsChanged} onAddAccount={onAddAccount} />
        )}
        {tab === "reports" && (
          <AccountsPage key={`r-${account?.id}`} section="reports" account={account} accounts={accounts} onAccountsChanged={onAccountsChanged} onAddAccount={onAddAccount} />
        )}
        {tab === "models" && <ModelsPage />}
        {tab === "org" && <OrgPage />}
      </div>
    </div>
  );
}
