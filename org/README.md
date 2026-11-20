# Trợ lý CDN — bản doanh nghiệp

Cho phòng kinh doanh: **mỗi người chạy app Trợ lý CDN trên máy mình với nick Zalo của mình** (như bản cá nhân), công ty
có thêm phần dùng chung trên **Supabase** và **trang quản lý** chạy trên **Vercel**.

```
Máy nhân viên (app + kết nối doanh nghiệp) ──┐
Máy nhân viên …                              ├── Supabase (Postgres + đăng nhập + RLS) ── Trang quản lý (Vercel)
Máy chủ công ty …                            ──┘
```

- Tin nhắn của khách **không rời máy nhân viên**. Supabase chỉ giữ: công ty, thành viên, máy đang chạy app (đợt 1); các đợt
  sau thêm kiến thức dùng chung, số liệu theo ngày, thẻ khách để giao / chuyển, cài đặt chung.
- Vì sao không chạy cả app trên Vercel: app giữ kết nối Zalo mở liên tục và gọi AI bằng gói Claude / ChatGPT cài trên máy;
  Vercel chỉ chạy từng lượt ngắn. Thêm nữa, nhiều nick Zalo cá nhân đăng nhập từ một máy chủ dễ bị Zalo hạn chế.
- Dùng một mình thì không cần phần này.

## Đã có (đợt 1)
- Supabase: bảng công ty, thành viên (chủ công ty / quản lý / nhân viên kinh doanh), mã mời, máy đang chạy app; mọi bảng khoá
  bằng Row Level Security (`supabase/migrations/0001_nen.sql`, có test chạy trên PGlite: `src/org/rls.test.ts`).
- App trên máy: **Cài đặt → Doanh nghiệp**: dán mã kết nối, nhập email, nhập mã xác nhận gửi về email → vào công ty. App báo
  "máy còn chạy" 5 phút một lần (phiên bản, nick Zalo đang chạy). Ngắt kết nối thì về bản cá nhân, dữ liệu giữ nguyên.
- Trang quản lý (`web/`): đăng nhập bằng mã email, tạo công ty, Tổng quan (thành viên, máy đang chạy, nick đang kết nối),
  Thành viên (đổi vai, gỡ người nghỉ, tạo / thu hồi mã kết nối).

### Vai trò và quyền
| Việc | Chủ công ty | Quản lý | Nhân viên kinh doanh |
|---|---|---|---|
| Xem thành viên, máy và nick Zalo đang chạy app | ✓ | ✓ | ✓ |
| Nối app trên máy mình vào công ty | ✓ | ✓ | ✓ |
| Mời nhân viên kinh doanh (tạo mã kết nối), gỡ nhân viên, thu hồi mã | ✓ | ✓ | — |
| Mời quản lý, đổi vai Quản lý ↔ Nhân viên, gỡ quản lý | ✓ | — | — |
| Chuyển quyền chủ công ty (chủ cũ thành quản lý) | ✓ | — | — |

Luật nằm ở Postgres (RLS + quyền theo cột, `supabase/migrations/0001_nen.sql`, `0002_phan_quyen.sql`), không dựa vào giao diện:
mã mời chỉ tạo qua hàm `create_invite`, không ai sửa được dòng của chủ công ty, sửa thành viên chỉ đổi được vai, gỡ ai thì máy
của người đó biến khỏi danh sách. Người chưa đăng nhập không đọc được bảng nào.

Các đợt tiếp: 2 kiến thức dùng chung · 3 bảng số liệu cả phòng · 4 giao / chuyển khách · 5 cài đặt dùng chung.

## Cài đặt (làm một lần)

### 1. Supabase
1. Tạo project mới (gói trả phí sẵn có dùng được). Vùng gần Việt Nam nhất: Singapore.
2. **SQL Editor** → dán lần lượt từng file trong `supabase/migrations/` theo thứ tự (`0001_nen.sql`, `0002_phan_quyen.sql`) → Run.
   Dùng chung project có sẵn cũng được (không tốn thêm phí): các bảng mới tên `orgs`, `members`, `invites`, `devices` — kiểm
   trước là project chưa có bảng trùng tên.
3. **Authentication → Providers → Email**: bật Email, bật "Confirm email".
4. **Authentication → Email Templates**: app và trang quản lý đăng nhập bằng **mã 6 số**, nên thêm dòng
   `Mã đăng nhập: {{ .Token }}` vào **cả hai** mẫu **Confirm signup** (người mới) và **Magic Link** (người đã có tài khoản).
   Có thể sửa tiêu đề thành "Mã đăng nhập Trợ lý CDN".
5. (Nên) **Authentication → SMTP Settings**: nối SMTP riêng (VD Gmail Workspace, Resend) vì email mặc định của Supabase
   bị giới hạn vài thư mỗi giờ.
6. **Project Settings → API**: lấy **Project URL** và **anon public key**. Không dùng `service_role` key ở đâu cả.

### 2. Vercel
1. New Project → chọn repo GitHub `tro-ly-cdn` → **Root Directory: `org/web`** (Framework: Next.js).
2. Environment Variables: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (giá trị ở bước 1.6).
3. Deploy. Muốn tên miền riêng (VD `team.congty.vn`): Settings → Domains.
4. Supabase **Authentication → URL Configuration**: thêm địa chỉ trang quản lý vào **Redirect URLs** (VD `https://ten-trang.vercel.app/**`). Đăng nhập dùng mã số gửi qua email nên không cần đổi Site URL; project Supabase dùng chung với web khác thì giữ nguyên Site URL của web đó.

Cách khác, không cần nối GitHub: trong `org/web` chạy `npx vercel login`, `npx vercel link`, khai hai biến bằng `npx vercel env add <TÊN> --environment production --value <giá trị> --no-sensitive`, rồi `npx vercel deploy --prod`. File `org/web/vercel.json` báo Vercel đây là Next.js (thiếu nó thì deploy lỗi "No Output Directory named public").

### 3. Dùng
1. Chủ công ty mở trang quản lý → đăng nhập bằng email → **Tạo công ty**.
2. **Thành viên → Tạo mã kết nối** → gửi đoạn `CDN1.…` cho nhân viên.
3. Nhân viên mở app Trợ lý CDN trên máy → **Cài đặt → Doanh nghiệp** → dán mã, nhập email, nhập mã xác nhận.
4. Trang quản lý → Tổng quan: thấy máy của nhân viên và nick Zalo đang chạy.

## Chạy thử trên máy
```
cd org/web
cp .env.example .env.local   # điền URL + anon key
npm install
npm run dev                   # http://localhost:3100
```
