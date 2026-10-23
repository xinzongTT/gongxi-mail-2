import os
import sys
import time
import logging
import threading
from queue import Queue, Empty
from datetime import datetime
from typing import Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

import tkinter as tk
from tkinter import filedialog, messagebox
from PIL import Image, ImageTk

try:
    import customtkinter as ctk
except ImportError:
    tk.Tk().withdraw()
    messagebox.showerror("缺少依赖", "请先在终端运行:\npip install customtkinter pillow")
    sys.exit(1)

# 日志配置
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")
logger = logging.getLogger(__name__)

# 全局自适应的高级质感暗黑主题
ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")  


class ModernRefreshTokenRefresher(ctk.CTk):
    def __init__(self):
        super().__init__()

        # --- 窗口基础设置 ---
        self.title("微软邮箱 OAuth2 令牌批量刷新工具")
        self.geometry("1180x820")
        self.minsize(1050, 750)
        
        # 居中窗口
        self.update_idletasks()
        width = self.winfo_width()
        height = self.winfo_height()
        x = (self.winfo_screenwidth() // 2) - (width // 2)
        y = (self.winfo_screenwidth() // 2) - (height // 2)
        self.geometry(f"{width}x{height}+{x}+{y}")

        # --- 数据状态 ---
        self.file_path: str = ""
        self.account_data: list[dict] = []
        self.processing_stats = {"total": 0, "success": 0, "failed": 0, "processed": 0}
        self.is_running: bool = False
        self.start_time: Optional[datetime] = None
        self.queue: Queue = Queue()
        self.worker_threads: list[threading.Thread] = []
        self.stats_lock = threading.Lock()
        self._thread_local = threading.local()

        # --- Tk 变量 ---
        self.progress_var = ctk.StringVar(value="完成进度: 0%")
        self.status_var = ctk.StringVar(value="准备就绪 - 请选择需要处理的文件")

        # 字体配置
        self.font_brand = ctk.CTkFont(family="Microsoft YaHei UI", size=24, weight="bold")
        self.font_h2 = ctk.CTkFont(family="Microsoft YaHei UI", size=16, weight="bold")
        self.font_main = ctk.CTkFont(family="Microsoft YaHei UI", size=14)
        self.font_sm = ctk.CTkFont(family="Microsoft YaHei UI", size=12)
        self.font_btn = ctk.CTkFont(family="Microsoft YaHei UI", size=15, weight="bold")
        self.font_num = ctk.CTkFont(family="Consolas", size=36, weight="bold")
        self.font_log = ctk.CTkFont(family="Consolas", size=13)

        self._build_ui()

    def _get_thread_session(self) -> requests.Session:
        session = getattr(self._thread_local, "session", None)
        if session is None:
            retry = Retry(
                total=3,
                connect=3,
                read=3,
                status=3,
                backoff_factor=0.6,
                status_forcelist=(429, 500, 502, 503, 504),
                allowed_methods=frozenset(["POST"]),
            )
            adapter = HTTPAdapter(pool_connections=20, pool_maxsize=20, max_retries=retry)
            session = requests.Session()
            session.mount("http://", adapter)
            session.mount("https://", adapter)
            self._thread_local.session = session
        return session

    def _set_status(self, text: str):
        self.after(0, lambda: self.status_var.set(text))

    # ─────────────────────────── UI 布局构建 ───────────────────────────────────

    def _build_ui(self):
        """左侧边栏 + 右侧主内容区的现代仪表盘布局"""
        
        # 必须给左侧边栏写死宽度，并在列配置里取消 weight=1 或 weight=0 等影响，让它绝对僵硬
        self.grid_rowconfigure(0, weight=1)
        self.grid_columnconfigure(0, weight=0, minsize=320)  # 左侧固定 320px
        self.grid_columnconfigure(1, weight=1)  # 右侧填满剩余空间

        # ------------------- 1. 左侧边栏 (控制区) -------------------
        sidebar = ctk.CTkFrame(self, width=320, corner_radius=0, fg_color="#18181B")
        sidebar.grid(row=0, column=0, sticky="nsew")
        sidebar.grid_rowconfigure(5, weight=1)

        # (1) Logo / 标题
        brand_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        brand_frame.grid(row=0, column=0, sticky="ew", padx=30, pady=(40, 30))
        
        ctk.CTkLabel(brand_frame, text="Token 刷新工具", font=self.font_brand, text_color="#FAFAFA").pack(anchor="w")
        ctk.CTkLabel(brand_frame, text="微软 OAuth2 账号管理客户端", font=self.font_sm, text_color="#A1A1AA").pack(anchor="w", pady=(2, 0))

        # (2) 文件选择区
        file_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        file_frame.grid(row=1, column=0, sticky="ew", padx=30, pady=(0, 25))
        
        ctk.CTkLabel(file_frame, text="账号数据文件", font=self.font_h2, text_color="#E4E4E7").pack(anchor="w", pady=(0, 10))
        self.file_entry = ctk.CTkEntry(
            file_frame, placeholder_text="格式: 邮箱--密码--ID--Token", 
            height=42, corner_radius=8, fg_color="#27272A", border_color="#3F3F46", text_color="#F4F4F5"
        )
        self.file_entry.pack(fill="x", pady=(0, 10))
        
        self.btn_browse = ctk.CTkButton(
            file_frame, text="选择本地 TXT 文件", height=42, corner_radius=8,
            font=self.font_btn, fg_color="#3F3F46", hover_color="#52525B",
            command=self.select_file
        )
        self.btn_browse.pack(fill="x")

        # (3) 并发控制区
        thread_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        thread_frame.grid(row=2, column=0, sticky="ew", padx=30, pady=(0, 30))
        
        ctk.CTkLabel(thread_frame, text="并发线程数量", font=self.font_h2, text_color="#E4E4E7").pack(anchor="w", pady=(0, 15))
        
        slider_box = ctk.CTkFrame(thread_frame, fg_color="transparent")
        slider_box.pack(fill="x")
        self.thread_slider = ctk.CTkSlider(
            slider_box, from_=1, to=150, number_of_steps=149,
            button_color="#3B82F6", button_hover_color="#2563EB", progress_color="#60A5FA",
            command=self._on_thread_change
        )
        self.thread_slider.pack(side="left", fill="x", expand=True, padx=(0, 15))
        self.thread_slider.set(20)

        self.thread_label = ctk.CTkLabel(
            slider_box, text="20", text_color="#60A5FA", font=ctk.CTkFont(family="Consolas", size=20, weight="bold"), width=40
        )
        self.thread_label.pack(side="right")

        # (4) 核心操作按钮
        action_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        action_frame.grid(row=3, column=0, sticky="ew", padx=30, pady=(0, 30))
        
        self.btn_start = ctk.CTkButton(
            action_frame, text="▶ 开始执行任务", height=48, corner_radius=10,
            font=self.font_btn, fg_color="#2563EB", hover_color="#1D4ED8", text_color="#FFFFFF",
            command=self.start_refreshing
        )
        self.btn_start.pack(fill="x", pady=(0, 15))
        
        self.btn_stop = ctk.CTkButton(
            action_frame, text="🛑 停止当前任务", height=48, corner_radius=10,
            font=self.font_btn, fg_color="transparent", hover_color="#7F1D1D", text_color="#F87171",
            border_width=1, border_color="#EF4444", state="disabled",
            command=self.stop_refreshing
        )
        self.btn_stop.pack(fill="x")

        # (5) 导出记录
        export_frame = ctk.CTkFrame(sidebar, fg_color="transparent")
        export_frame.grid(row=4, column=0, sticky="ew", padx=30, pady=(15, 0))
        
        self.btn_export_success = ctk.CTkButton(
            export_frame, text="💾 导出成功数据", height=42, corner_radius=8,
            font=self.font_main, fg_color="#10B981", hover_color="#059669", 
            state="disabled", command=self.export_success_results
        )
        self.btn_export_success.pack(fill="x", pady=(0, 12))
        
        self.btn_export_failed = ctk.CTkButton(
            export_frame, text="� 导出失败数据", height=42, corner_radius=8,
            font=self.font_main, fg_color="#52525B", hover_color="#3F3F46",
            state="disabled", command=self.export_failed_results
        )
        self.btn_export_failed.pack(fill="x")

        # (6) 底部状态栏
        status_bar = ctk.CTkFrame(sidebar, fg_color="#09090B", corner_radius=0, height=50)
        status_bar.grid(row=6, column=0, sticky="ew")
        status_bar.pack_propagate(False)
        status_bar.grid_propagate(False)
        
        # 锁定左下状态栏文字宽度，避免左侧栏被撑宽 
        self.lbl_sidebar_status = ctk.CTkLabel(
            status_bar, textvariable=self.status_var, font=self.font_sm, text_color="#10B981", 
            anchor="w", justify="left"
        )
        self.lbl_sidebar_status.pack(side="left", fill="x", expand=True, padx=25, pady=15)


        # ------------------- 2. 右侧主工作区 (数据与日志) -------------------
        main_area = ctk.CTkFrame(self, corner_radius=0, fg_color="#09090B")
        main_area.grid(row=0, column=1, sticky="nsew", padx=0, pady=0)
        
        main_area.grid_columnconfigure(0, weight=1)
        main_area.grid_rowconfigure(2, weight=1)

        # -------------- 顶部统计卡片 --------------
        stats_grid = ctk.CTkFrame(main_area, fg_color="transparent")
        stats_grid.grid(row=0, column=0, sticky="ew", padx=40, pady=(40, 20))
        stats_grid.grid_columnconfigure((0,1,2,3), weight=1)

        def create_metric_card(parent, title, bg_color, text_color, highlight_color, col, pd_left=0, pd_right=0):
            card = ctk.CTkFrame(parent, corner_radius=16, fg_color=bg_color, border_width=1, border_color="#27272A")
            card.grid(row=0, column=col, sticky="ew", padx=(pd_left, pd_right))
            
            ctk.CTkLabel(card, text=title, text_color="#A1A1AA", font=self.font_main).pack(anchor="nw", padx=24, pady=(20, 0))
            lbl = ctk.CTkLabel(card, text="0", text_color=highlight_color, font=self.font_num)
            lbl.pack(anchor="sw", padx=24, pady=(5, 20))
            return lbl

        self.lbl_total = create_metric_card(stats_grid, "总账号数", "#18181B", "#F4F4F5", "#60A5FA", 0, pd_right=12)
        self.lbl_success = create_metric_card(stats_grid, "成功数量", "#18181B", "#F4F4F5", "#34D399", 1, pd_left=6, pd_right=6)
        self.lbl_failed = create_metric_card(stats_grid, "失败数量", "#18181B", "#F4F4F5", "#F87171", 2, pd_left=6, pd_right=6)
        self.lbl_rate = create_metric_card(stats_grid, "成功率", "#18181B", "#F4F4F5", "#7DD3FC", 3, pd_left=12)

        # -------------- 任务进度条 --------------
        prog_inner = ctk.CTkFrame(main_area, corner_radius=12, fg_color="#18181B", border_width=1, border_color="#27272A")
        prog_inner.grid(row=1, column=0, sticky="ew", padx=40, pady=20)
        
        header_prog = ctk.CTkFrame(prog_inner, fg_color="transparent", height=30)
        header_prog.pack(fill="x", padx=25, pady=(20, 5))
        header_prog.pack_propagate(False)
        
        ctk.CTkLabel(header_prog, text="当前任务进度", font=self.font_h2, text_color="#E4E4E7").pack(side="left")
        
        # 右侧百分比文字锁定宽度并靠右对齐
        self.lbl_pct = ctk.CTkLabel(
            header_prog, textvariable=self.progress_var, font=self.font_sm, text_color="#A1A1AA",
            width=200, anchor="e", justify="right"
        )
        self.lbl_pct.pack(side="right")
        
        self.progress_bar = ctk.CTkProgressBar(prog_inner, height=14, corner_radius=7, fg_color="#09090B", progress_color="#3B82F6")
        self.progress_bar.set(0)
        self.progress_bar.pack(fill="x", padx=25, pady=(8, 25))

        # -------------- 日志面板 --------------
        log_container = ctk.CTkFrame(main_area, corner_radius=16, fg_color="#18181B", border_width=1, border_color="#27272A")
        log_container.grid(row=2, column=0, sticky="nsew", padx=40, pady=(20, 40))
        log_container.grid_columnconfigure(0, weight=1)
        log_container.grid_rowconfigure(1, weight=1)

        log_head = ctk.CTkFrame(log_container, fg_color="transparent")
        log_head.grid(row=0, column=0, sticky="ew", padx=25, pady=(20, 10))
        
        ctk.CTkLabel(log_head, text="» 运行日志", font=self.font_h2, text_color="#D4D4D8").pack(side="left")
        ctk.CTkButton(
            log_head, text="清空日志", width=60, height=28, corner_radius=6,
            fg_color="transparent", hover_color="#27272A", text_color="#A1A1AA",
            font=self.font_sm, command=self.clear_logs
        ).pack(side="right")

        self.log_text = ctk.CTkTextbox(
            log_container, wrap="none", font=self.font_log,
            fg_color="#09090B", text_color="#D4D4D8", corner_radius=10
        )
        self.log_text.grid(row=1, column=0, sticky="nsew", padx=25, pady=(0, 25))

        self.log("初始化完成，界面布局已准备就绪。")

    # ─────────────────────────── 事件与核心逻辑 ───────────────────────────────────

    def _on_thread_change(self, value):
        v = int(float(value))
        self.thread_label.configure(text=str(v))

    def select_file(self):
        path = filedialog.askopenfilename(filetypes=[("Text Data", "*.txt"), ("Any File", "*.*")])
        if path:
            self.file_path = path
            self.file_entry.delete(0, "end")
            self.file_entry.insert(0, path)
            self.log(f"已选择文件: {path}")
            self._validate_file_format()

    def _validate_file_format(self):
        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                first_line = f.readline().strip()
            if not first_line:
                self.log("警告: 选中的文件为空，请检查文件内容。")
                return
            parts = first_line.split("----")
            if len(parts) != 4:
                self.log("错误: 文件格式不正确！正确格式为: 邮箱----密码----client_id----refresh_token")
            else:
                self.log("成功: 文件格式校验通过，可以开始执行。")
        except Exception as e:
            self.log(f"错误: 读取文件时发生异常 - {e}")

    def log(self, message: str):
        def _write():
            self.log_text.configure(state="normal")
            ts = datetime.now().strftime("%H:%M:%S")
            prefix = "[INFO]"
            if "错误" in message or "失败" in message or "异常" in message:
                prefix = "[ERROR]"
            elif "成功" in message or "完成" in message:
                prefix = "[SUCCESS]"
            elif "警告" in message:
                prefix = "[WARN]"
                
            full_msg = f"{ts} {prefix} - {message}\n"
            self.log_text.insert("end", full_msg)
            self.log_text.see("end")
            self.log_text.configure(state="disabled")
        self.after(0, _write)
        logger.info(message)

    def clear_logs(self):
        self.log_text.configure(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.configure(state="disabled")

    def start_refreshing(self):
        if not self.file_path:
            messagebox.showwarning("提示", "请先在左侧选择需要读取的账号文件！")
            return

        self.is_running = True
        self.start_time = datetime.now()
        with self.stats_lock:
            self.processing_stats = {"total": 0, "success": 0, "failed": 0, "processed": 0}
        self.account_data = []
        self.queue = Queue()
        self.worker_threads = []

        self.btn_start.configure(state="disabled", text="任务执行中...", fg_color="#1E3A8A")
        self.btn_stop.configure(state="normal")
        self.btn_export_success.configure(state="disabled")
        self.btn_export_failed.configure(state="disabled")
        
        self.progress_bar.configure(progress_color="#60A5FA")
        self.progress_var.set("完成度: 0%")
        self.progress_bar.set(0)
        self.lbl_rate.configure(text="0%")
        self.lbl_success.configure(text="0")
        self.lbl_failed.configure(text="0")
        self._set_status("状态: 正在读取并解析文件数据…")

        try:
            with open(self.file_path, "r", encoding="utf-8") as f:
                for line_num, line in enumerate(f, 1):
                    line = line.strip()
                    if not line:
                        continue
                    parts = line.split("----")
                    if len(parts) != 4:
                        self.log(f"提示: 第 {line_num} 行格式不符，已自动跳过。")
                        continue
                    email, password, client_id, refresh_token = parts
                    account = {
                        "email": email, "password": password,
                        "client_id": client_id, "original_refresh_token": refresh_token,
                        "new_refresh_token": None, "status": "pending",
                    }
                    self.account_data.append(account)
                    self.queue.put(account)
        except Exception as e:
            self.log(f"错误: 读取数据文件失败 - {e}")
            self._finish_processing()
            return

        with self.stats_lock:
            self.processing_stats["total"] = len(self.account_data)
        self.lbl_total.configure(text=str(len(self.account_data)))

        if not self.account_data:
            self.log("提示: 文件中未找到有效的账号数据，任务结束。")
            self._finish_processing()
            return

        self.log(f"文件读取成功，共加载 {len(self.account_data)} 个账号数据。")
        self._set_status("状态: 正在通过 API 进行批量刷新…")

        thread_count = int(self.thread_slider.get())
        for _ in range(min(thread_count, len(self.account_data))):
            t = threading.Thread(target=self._worker, daemon=True)
            t.start()
            self.worker_threads.append(t)

        threading.Thread(target=self._update_status_loop, daemon=True).start()
        threading.Thread(target=self._check_completion, daemon=True).start()

    def stop_refreshing(self):
        self.is_running = False
        while not self.queue.empty():
            try:
                self.queue.get_nowait()
                self.queue.task_done()
            except Empty:
                break
        self._set_status("状态: 用户手动终止任务，正在等待剩余线程退出…")
        self.log("提示: 任务已被手动终止，未处理的数据已从队列中移除。")

    def _worker(self):
        while self.is_running:
            try:
                account = self.queue.get(timeout=0.5)
            except Empty:
                if self.queue.empty():
                    break
                continue

            try:
                self._process_single_account(account)
            except Exception as e:
                self.log(f"错误: 处理账号 {account['email']} 时发生异常 - {e}")
                account["status"] = "failed"
                with self.stats_lock:
                    self.processing_stats["failed"] += 1
            finally:
                self.queue.task_done()

    def _process_single_account(self, account: dict):
        with self.stats_lock:
            self.processing_stats["processed"] += 1

        result = self._refresh_token(account["original_refresh_token"], account["client_id"])

        if result and result.get("refresh_token"):
            account["new_refresh_token"] = result["refresh_token"]
            account["status"] = "success"
            with self.stats_lock:
                self.processing_stats["success"] += 1
            self.log(f"成功: {account['email']} - Token 刷新完成")
        else:
            account["status"] = "failed"
            with self.stats_lock:
                self.processing_stats["failed"] += 1
            msg = result.get("message", "未知网络错误") if result else "网络请求失败"
            self.log(f"失败: {account['email']} - {msg}")

        self.after(0, self._update_progress)

    def _refresh_token(self, refresh_token: str, client_id: str, tenant_id: str = "common") -> Optional[dict]:
        token_url = f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"
        payload = {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id}

        try:
            session = self._get_thread_session()
            response = session.post(token_url, data=payload, timeout=12)
            if response.status_code != 200:
                err_desc = response.json().get("error_description", f"HTTP状态码: {response.status_code}")
                return {"message": err_desc[:80].replace('\r', '').replace('\n', '')}
            
            data = response.json()
            if "refresh_token" in data:
                return data
            return {"message": "返回的 JSON 数据异常"}
        except Exception as e:
            return {"message": str(e)}

    def _update_progress(self):
        with self.stats_lock:
            processed = self.processing_stats["processed"]
            total = self.processing_stats["total"]
            success = self.processing_stats["success"]
            failed = self.processing_stats["failed"]
        
        pct = (processed / total) if total > 0 else 0
        rate = f"{(success / total * 100):.1f}%" if total > 0 else "0%"
        
        self.progress_var.set(f"完成度: {int(pct*100)}% ({processed}/{total})")
        self.progress_bar.set(pct)
        self.lbl_success.configure(text=str(success))
        self.lbl_failed.configure(text=str(failed))
        self.lbl_rate.configure(text=rate)

    def _update_status_loop(self):
        while self.is_running:
            if self.start_time:
                elapsed = (datetime.now() - self.start_time).total_seconds()
                h, rem = divmod(int(elapsed), 3600)
                m, s = divmod(rem, 60)
                with self.stats_lock:
                    processed = self.processing_stats["processed"]
                speed = int(processed / max(elapsed / 60, 1))
                self._set_status(f"状态: 任务执行中 | 运行时长: {h:02d}:{m:02d}:{s:02d} | 速度: {speed} 条/分钟")
            time.sleep(1)

    def _check_completion(self):
        self.queue.join()
        if self.is_running:
            self.after(0, self._finish_processing)

    def _finish_processing(self):
        self.is_running = False
        self.btn_start.configure(state="normal", text="▶ 重新开始任务", fg_color="#2563EB")
        self.btn_stop.configure(state="disabled")
        self.progress_bar.configure(progress_color="#10B981") 
        
        with self.stats_lock:
            stats = dict(self.processing_stats)

        if stats["success"] > 0:
            self.btn_export_success.configure(state="normal", fg_color="#10B981")
        if stats["failed"] > 0:
            self.btn_export_failed.configure(state="normal", fg_color="#3F3F46")

        if self.start_time:
            elapsed = (datetime.now() - self.start_time).total_seconds()
            speed = int(stats["processed"] / max(elapsed / 60, 1))
            self._set_status(f"完成: 任务已结束 | 总耗时: {int(elapsed)}秒 | 平均速度: {speed}条/分钟")
            self.log(f"任务结束统计 - 总量: {stats['total']} | 成功: {stats['success']} | 失败: {stats['failed']}")

    def export_success_results(self):
        with self.stats_lock:
            if self.processing_stats["success"] == 0:
                return
        try:
            now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            base = os.path.splitext(os.path.basename(self.file_path))[0]
            dir_name = os.path.dirname(self.file_path)
            export_path = os.path.join(dir_name, f"成功导出结果_{base}_{now_str}.txt")

            with open(export_path, "w", encoding="utf-8") as f:
                for acc in self.account_data:
                    if acc["status"] == "success" and acc["new_refresh_token"]:
                        f.write(f"{acc['email']}----{acc['password']}----{acc['client_id']}----{acc['new_refresh_token']}\n")
            self.log(f"成功: 数据已成功导出至文件: {export_path}")
            messagebox.showinfo("导出成功", f"刷新的成功数据已保存到:\n\n{export_path}")
        except Exception as e:
            self.log(f"错误: 导出成功文件时发生异常: {e}")

    def export_failed_results(self):
        with self.stats_lock:
            if self.processing_stats["failed"] == 0:
                return
        try:
            now_str = datetime.now().strftime("%Y%m%d_%H%M%S")
            base = os.path.splitext(os.path.basename(self.file_path))[0]
            dir_name = os.path.dirname(self.file_path)
            export_path = os.path.join(dir_name, f"失败重试名单_{base}_{now_str}.txt")

            with open(export_path, "w", encoding="utf-8") as f:
                for acc in self.account_data:
                    if acc["status"] == "failed":
                        f.write(f"{acc['email']}----{acc['password']}----{acc['client_id']}----{acc['original_refresh_token']}\n")
            self.log(f"成功: 失败的数据集已导出至文件: {export_path}")
            messagebox.showinfo("导出成功", f"刷新失败的数据已保存到:\n\n{export_path}")
        except Exception as e:
            self.log(f"错误: 导出失败文件时发生异常: {e}")

if __name__ == "__main__":
    app = ModernRefreshTokenRefresher()
    app.mainloop()
