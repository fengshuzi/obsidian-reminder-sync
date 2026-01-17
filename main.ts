import { Plugin, Notice, TFile, Platform } from 'obsidian';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// 配置接口
interface ReminderSyncConfig {
    appName: string;
    categories: Record<string, string>;
    expenseEmoji: string;
    journalsPath: string;
    reminderListName: string;
    autoSync: boolean;
    syncInterval: number;
    notifyOnSync: boolean;
    smartKeywords?: Record<string, string[]>;
    habits?: Record<string, string>;
    habitPrefix?: string;
    habitKeywords?: Record<string, string[]>;
    videoTypes?: Record<string, string>;
    videoKeywords?: Record<string, string[]>;
}

// 提醒事项接口
interface Reminder {
    id: string;
    title: string;
    due?: string;
    list: string;
    completed: boolean;
}

// 记账记录接口
interface AccountingEntry {
    keyword: string;
    category: string;
    amount: number;
    description: string;
    date: string;
    reminderId: string;
}

// 打卡记录接口
interface HabitEntry {
    habitKey: string;
    habitName: string;
    description: string;
    date: string;
    reminderId: string;
}

// 视频记录接口
interface VideoEntry {
    typeKey: string;
    typeName: string;
    title: string;
    comment: string;
    date: string;
    reminderId: string;
}

// 格式化本地日期为 YYYY-MM-DD
function formatLocalDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 提醒事项同步插件
 * 
 * 功能：
 * 1. 双向同步：日记任务 ↔ macOS 提醒事项
 * 2. 支持记账、打卡、视频等多种类型的提醒
 * 3. 自动去重，避免重复创建提醒
 * 
 * 同步锁机制：
 * - 使用 withSyncLock() 统一管理锁的获取和释放
 * - 所有同步操作通过队列顺序执行，避免并发问题
 * - 锁的获取和释放完全由 withSyncLock() 控制，避免手动管理导致的泄漏
 */
export default class ReminderSyncPlugin extends Plugin {
    config: ReminderSyncConfig;
    syncIntervalId: number | null = null;
    private syncDebounceTimers: Map<string, number> = new Map();
    private globalSyncing: boolean = false;
    private syncLock: boolean = false;
    private syncQueue: Promise<void> = Promise.resolve();

    /**
     * 统一的锁管理器 - 所有同步操作必须通过此方法执行
     * 
     * @param name 操作名称（用于日志）
     * @param fn 要执行的异步函数
     * @param skipIfBusy 如果锁被占用是否跳过（true=跳过，false=排队等待）
     * @returns 执行结果，如果跳过则返回 null
     */
    private withSyncLock<T>(name: string, fn: () => Promise<T>, skipIfBusy = false): Promise<T | null> {
        // 如果设置了 skipIfBusy 且锁被占用，直接跳过
        if (skipIfBusy && this.syncLock) {
            console.log(`[ReminderSync] ⏭️ 锁被占用，跳过: ${name}`);
            return Promise.resolve(null);
        }

        // 创建任务并加入队列
        const task = this.syncQueue.then(async (): Promise<T> => {
            this.syncLock = true;
            console.log(`[ReminderSync] 🔒 获取锁: ${name}`);
            
            try {
                return await fn();
            } finally {
                this.syncLock = false;
                console.log(`[ReminderSync] 🔓 释放锁: ${name}`);
            }
        });

        // 更新队列（忽略错误，确保队列继续）
        this.syncQueue = task.then(() => {}, () => {});
        
        return task;
    }

    async onload() {
        console.log('加载提醒事项记账同步插件');

        if (!Platform.isMacOS) {
            new Notice('提醒事项记账同步插件仅支持 macOS 系统');
            return;
        }

        await this.loadConfig();

        this.addCommand({
            id: 'sync-reminders-to-journal',
            name: '同步提醒事项到日记',
            callback: () => this.syncRemindersToJournal()
        });

        this.addCommand({
            id: 'preview-sync-reminders',
            name: '预览待同步的提醒事项',
            callback: () => this.previewSyncReminders()
        });

        this.addCommand({
            id: 'sync-journals-to-reminders',
            name: '同步到提醒事项',
            callback: () => this.syncJournalsToReminders()
        });

        if (this.config.autoSync) {
            this.startAutoSync();
        }

        this.registerEvent(
            this.app.workspace.on('file-open', async (file) => {
                if (file && file.extension === 'md') {
                    this.debounceSyncFile(file);
                }
            })
        );

        let previousFile: TFile | null = null;
        this.registerEvent(
            this.app.workspace.on('active-leaf-change', async () => {
                const currentFile = this.app.workspace.getActiveFile();
                if (previousFile && previousFile.extension === 'md') {
                    this.debounceSyncFile(previousFile);
                }
                previousFile = currentFile;
            })
        );

        // 插件加载时执行一次双向同步
        setTimeout(() => {
            console.log('[ReminderSync] 插件加载完成，开始后台同步...');
            this.globalSyncing = true;
            this.performFullSync(true).finally(() => {
                this.globalSyncing = false;
                console.log('[ReminderSync] 后台同步完成');
            });
        }, 1000);
    }

    async onunload() {
        console.log('卸载提醒事项记账同步插件');
        this.stopAutoSync();
    }

    async loadConfig() {
        const configPath = `${this.manifest.dir}/config.json`;
        const adapter = this.app.vault.adapter;
        
        try {
            const configContent = await adapter.read(configPath);
            this.config = JSON.parse(configContent);
        } catch (error) {
            console.error('加载配置失败:', error);
            new Notice('提醒事项记账同步插件：配置文件加载失败，请检查 config.json');
            throw error;
        }
    }

    startAutoSync() {
        if (this.syncIntervalId) return;
        console.log(`启动自动同步，间隔: ${this.config.syncInterval}ms`);
        this.syncIntervalId = window.setInterval(
            () => this.syncRemindersToJournal(true),
            this.config.syncInterval
        );
    }

    stopAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            console.log('停止自动同步');
        }
    }

    async runJXA(script: string): Promise<any> {
        try {
            const { stdout } = await execAsync(`osascript -l JavaScript -e "${script}"`, {
                timeout: 30000
            });
            return stdout.trim();
        } catch (error) {
            console.error('[ReminderSync] JXA Error:', error);
            return null;
        }
    }

    async getReminders(): Promise<Reminder[]> {
        const threeDaysAgo = new Date();
        threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
        const threeDaysAgoISO = threeDaysAgo.toISOString();
        
        const script = `
var Reminders=Application('Reminders');
var result=[];
var lists=Reminders.lists();
var listCount=lists.length;
var threeDaysAgo=new Date('${threeDaysAgoISO}');
for(var i=0;i<listCount;i++){
    var list=lists[i];
    var listName=list.name();
    if(listName!=='${this.config.reminderListName}')continue;
    var allReminders=list.reminders();
    var reminderCount=allReminders.length;
    for(var j=0;j<reminderCount;j++){
        try{
            var r=allReminders[j];
            var isCompleted=r.completed();
            var dueDate=r.dueDate();
            if(isCompleted){
                if(!dueDate||dueDate.toString()==='missing value')continue;
                var dueDateTime=new Date(dueDate);
                if(dueDateTime<threeDaysAgo)continue;
            }
            var item={title:r.name(),id:r.id(),list:listName,completed:isCompleted};
            if(dueDate&&dueDate.toString()!=='missing value'){
                item.due=dueDate.toISOString();
            }
            result.push(item);
        }catch(e){
            continue;
        }
    }
    break;
}
JSON.stringify(result);
        `.replace(/\n/g, '');

        const output = await this.runJXA(script);
        if (!output) return [];

        try {
            return JSON.parse(output);
        } catch (error) {
            console.error('[ReminderSync] Parse Error:', error);
            return [];
        }
    }

    parseReminderTitle(title: string): AccountingEntry | null {
        const { categories, expenseEmoji, smartKeywords } = this.config;
        
        if (!/\d/.test(title)) {
            return null;
        }
        
        if (title.includes(expenseEmoji)) {
            const keywords = Object.keys(categories).sort((a, b) => b.length - a.length);
            const keywordPattern = keywords.join('|');
            const keywordRegex = new RegExp(`${expenseEmoji}\\s*(${keywordPattern})\\s*(.+)`, 'i');
            const keywordMatch = keywordRegex.exec(title);
            
            if (keywordMatch) {
                const keyword = keywordMatch[1];
                const restContent = keywordMatch[2];
                const amountRegex = /[\d.]+/;
                const amountMatch = restContent.match(amountRegex);
                
                if (amountMatch) {
                    const amount = parseFloat(amountMatch[0]);
                    if (!isNaN(amount) && amount > 0) {
                        const category = categories[keyword] || '未分类';
                        const amountWithUnit = new RegExp(amountMatch[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(块钱|元|块)?');
                        const description = restContent.replace(amountWithUnit, '').trim();
                        
                        return {
                            keyword,
                            category,
                            amount: amount,
                            description: description,
                            date: '',
                            reminderId: ''
                        };
                    }
                }
            }
        }
        
        if (smartKeywords) {
            for (const [keyword, triggers] of Object.entries(smartKeywords)) {
                const hasTrigger = triggers.some(trigger => title.includes(trigger));
                if (hasTrigger) {
                    const category = categories[keyword] || '未分类';
                    return {
                        keyword,
                        category,
                        amount: 0,
                        description: title,
                        date: '',
                        reminderId: ''
                    };
                }
            }
        }
        
        return null;
    }

    parseHabitReminder(title: string): HabitEntry | null {
        const { habits, habitKeywords } = this.config;
        
        if (!habits || !habitKeywords) {
            return null;
        }
        
        for (const [habitKey, triggers] of Object.entries(habitKeywords)) {
            const hasTrigger = triggers.some(trigger => title.includes(trigger));
            if (hasTrigger) {
                const habitName = habits[habitKey];
                return {
                    habitKey,
                    habitName,
                    description: title,
                    date: '',
                    reminderId: ''
                };
            }
        }
        
        return null;
    }

    parseVideoReminder(title: string): VideoEntry | null {
        const { videoTypes, videoKeywords } = this.config;
        
        if (!videoTypes || !videoKeywords) {
            return null;
        }
        
        for (const [typeKey, triggers] of Object.entries(videoKeywords)) {
            const hasTrigger = triggers.some(trigger => title.includes(trigger));
            if (hasTrigger) {
                const typeName = videoTypes[typeKey];
                let videoTitle = '';
                let comment = '';
                
                const titleMatch = title.match(/《([^》]+)》/);
                if (titleMatch) {
                    videoTitle = titleMatch[1];
                    comment = title.replace(titleMatch[0], '').trim();
                } else {
                    comment = title;
                    videoTitle = '';
                }
                
                return {
                    typeKey,
                    typeName,
                    title: videoTitle,
                    comment: comment,
                    date: '',
                    reminderId: ''
                };
            }
        }
        
        return null;
    }

    async previewSyncReminders() {
        new Notice('正在读取提醒事项...');
        
        const reminders = await this.getReminders();
        if (reminders.length === 0) {
            new Notice('未找到提醒事项');
            return;
        }

        const accountingReminders = reminders
            .map(reminder => {
                const entry = this.parseReminderTitle(reminder.title);
                if (!entry) return null;
                
                entry.date = reminder.due 
                    ? formatLocalDate(new Date(reminder.due))
                    : formatLocalDate(new Date());
                entry.reminderId = reminder.id;
                
                return { reminder, entry };
            })
            .filter(item => item !== null);

        if (accountingReminders.length === 0) {
            new Notice('未找到包含记账标签的提醒事项');
            return;
        }

        let message = `找到 ${accountingReminders.length} 条待同步的记账提醒：\n\n`;
        accountingReminders.forEach(({ reminder, entry }) => {
            message += `📅 ${entry.date}\n`;
            message += `${this.config.expenseEmoji}${entry.keyword} ${entry.amount}`;
            if (entry.description) {
                message += ` ${entry.description}`;
            }
            message += `\n\n`;
        });

        new Notice(message, 10000);
        console.log('待同步提醒:', accountingReminders);
    }

    /**
     * 执行完整的双向同步（内部使用）
     * 顺序执行：1. 提醒→日记  2. 日记→提醒
     */
    private async performFullSync(silent = false): Promise<void> {
        await this.withSyncLock('performFullSync', async () => {
            // 步骤1：同步提醒事项到日记
            console.log('[ReminderSync] 📥 步骤1: 同步提醒事项到日记');
            await this.syncRemindersToJournalInternal(silent);
            
            // 等待500ms，让提醒事项系统更新
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // 步骤2：同步日记到提醒事项
            console.log('[ReminderSync] 📤 步骤2: 同步日记到提醒事项');
            await this.syncJournalsToRemindersInternal(silent);
        });
    }

    /**
     * 同步提醒事项到日记（公开接口）
     */
    async syncRemindersToJournal(silent = false) {
        console.log('[ReminderSync] syncRemindersToJournal 被调用');
        
        const result = await this.withSyncLock(
            'syncRemindersToJournal',
            () => this.syncRemindersToJournalInternal(silent),
            silent // 静默模式跳过，手动触发时排队等待
        );
        
        if (result === null && !silent) {
            new Notice('同步正在进行中，请稍候...');
        }
    }

    /**
     * 同步日记任务到提醒事项（公开接口）
     */
    async syncJournalsToReminders(silent = false): Promise<void> {
        console.log('[ReminderSync] syncJournalsToReminders 被调用');
        
        const result = await this.withSyncLock(
            'syncJournalsToReminders',
            () => this.syncJournalsToRemindersInternal(silent),
            silent
        );
        
        if (result === null && !silent) {
            new Notice('同步正在进行中，请稍候...');
        }
    }

    /**
     * 同步提醒事项到日记（内部实现）
     */
    private async syncRemindersToJournalInternal(silent = false): Promise<void> {
        if (!silent) {
            new Notice('开始同步提醒事项...');
        }
        
        console.log('[ReminderSync] 🔄 刷新提醒列表');
        const reminders = await this.getReminders();
        if (reminders.length === 0) {
            if (!silent) {
                new Notice('未找到提醒事项');
            }
            return;
        }

        const accountingEntries: Array<{ reminder: Reminder; entry: AccountingEntry }> = [];
        const habitEntries: Array<{ reminder: Reminder; entry: HabitEntry }> = [];
        const videoEntries: Array<{ reminder: Reminder; entry: VideoEntry }> = [];
        
        for (const reminder of reminders) {
            const accountingEntry = this.parseReminderTitle(reminder.title);
            if (accountingEntry) {
                accountingEntry.date = reminder.due 
                    ? formatLocalDate(new Date(reminder.due))
                    : formatLocalDate(new Date());
                accountingEntry.reminderId = reminder.id;
                accountingEntries.push({ reminder, entry: accountingEntry });
                continue;
            }
            
            const videoEntry = this.parseVideoReminder(reminder.title);
            if (videoEntry) {
                videoEntry.date = reminder.due 
                    ? formatLocalDate(new Date(reminder.due))
                    : formatLocalDate(new Date());
                videoEntry.reminderId = reminder.id;
                videoEntries.push({ reminder, entry: videoEntry });
                continue;
            }
            
            const habitEntry = this.parseHabitReminder(reminder.title);
            if (habitEntry) {
                habitEntry.date = reminder.due 
                    ? formatLocalDate(new Date(reminder.due))
                    : formatLocalDate(new Date());
                habitEntry.reminderId = reminder.id;
                habitEntries.push({ reminder, entry: habitEntry });
            }
        }

        if (accountingEntries.length === 0 && habitEntries.length === 0 && videoEntries.length === 0) {
            if (!silent) {
                new Notice('未找到记账、打卡或视频提醒');
            }
            return;
        }

        let syncCount = 0;
        const deletedReminders: string[] = [];
        
        // 同步记账提醒
        if (accountingEntries.length > 0) {
            const entriesByDate: Record<string, Array<{ reminder: Reminder; entry: AccountingEntry }>> = {};
            for (const item of accountingEntries) {
                const date = item.entry.date;
                if (!entriesByDate[date]) {
                    entriesByDate[date] = [];
                }
                entriesByDate[date].push(item);
            }

            for (const [date, items] of Object.entries(entriesByDate)) {
                const entries = items.map(item => item.entry);
                const success = await this.syncAccountingToJournal(date, entries);
                
                if (success) {
                    syncCount += entries.length;
                    for (const item of items) {
                        const deleted = await this.deleteReminder(item.reminder.id);
                        if (deleted) {
                            deletedReminders.push(item.reminder.title);
                            console.log(`[ReminderSync] 已删除记账提醒: ${item.reminder.title}`);
                        }
                    }
                }
            }
        }
        
        // 同步打卡提醒
        if (habitEntries.length > 0) {
            const entriesByDate: Record<string, Array<{ reminder: Reminder; entry: HabitEntry }>> = {};
            for (const item of habitEntries) {
                const date = item.entry.date;
                if (!entriesByDate[date]) {
                    entriesByDate[date] = [];
                }
                entriesByDate[date].push(item);
            }

            for (const [date, items] of Object.entries(entriesByDate)) {
                const entries = items.map(item => item.entry);
                const success = await this.syncHabitsToJournal(date, entries);
                
                if (success) {
                    syncCount += entries.length;
                    for (const item of items) {
                        const deleted = await this.deleteReminder(item.reminder.id);
                        if (deleted) {
                            deletedReminders.push(item.reminder.title);
                            console.log(`[ReminderSync] 已删除打卡提醒: ${item.reminder.title}`);
                        }
                    }
                }
            }
        }
        
        // 同步视频提醒
        if (videoEntries.length > 0) {
            const entriesByDate: Record<string, Array<{ reminder: Reminder; entry: VideoEntry }>> = {};
            for (const item of videoEntries) {
                const date = item.entry.date;
                if (!entriesByDate[date]) {
                    entriesByDate[date] = [];
                }
                entriesByDate[date].push(item);
            }

            for (const [date, items] of Object.entries(entriesByDate)) {
                const entries = items.map(item => item.entry);
                const success = await this.syncVideosToJournal(date, entries);
                
                if (success) {
                    syncCount += entries.length;
                    for (const item of items) {
                        const deleted = await this.deleteReminder(item.reminder.id);
                        if (deleted) {
                            deletedReminders.push(item.reminder.title);
                            console.log(`[ReminderSync] 已删除视频提醒: ${item.reminder.title}`);
                        }
                    }
                }
            }
        }

        if (!silent) {
            new Notice(`同步完成！共同步 ${syncCount} 条记录，删除 ${deletedReminders.length} 条提醒`);
        }
        
        console.log(`[ReminderSync] 同步完成: ${syncCount} 条记录，删除 ${deletedReminders.length} 条提醒`);
    }

    /**
     * 同步日记任务到提醒事项（内部实现）
     */
    private async syncJournalsToRemindersInternal(silent = false): Promise<void> {
        if (!silent) {
            new Notice('开始同步日记任务到提醒事项...');
        }

        const { vault } = this.app;
        const journalsPath = this.config.journalsPath;
        const journalFiles = vault.getMarkdownFiles().filter(file => 
            file.path.startsWith(journalsPath)
        );

        let createdCount = 0;

        for (const file of journalFiles) {
            const content = await vault.read(file);
            const lines = content.split('\n');

            for (const line of lines) {
                const taskMatch = line.match(/^-\s+(?:\[([x\sX])\]|TODO|DONE)\s+(.+?)\s+@(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}))?/);
                
                if (taskMatch) {
                    const [, checkboxStatus, taskTitle, date, hours, minutes] = taskMatch;
                    const isCompleted = checkboxStatus === 'x' || checkboxStatus === 'X' || line.includes('DONE');
                    
                    const taskDate = new Date(date);
                    const today = new Date();
                    today.setHours(0, 0, 0, 0);
                    
                    if (taskDate < today) {
                        continue;
                    }
                    
                    let finalTaskTitle = taskTitle;
                    let finalHours = hours;
                    let finalMinutes = minutes;
                    
                    const timeInTitle = taskTitle.match(/^(\d{2}):(\d{2})\s+(.+)/);
                    if (timeInTitle && !hours) {
                        finalHours = timeInTitle[1];
                        finalMinutes = timeInTitle[2];
                        finalTaskTitle = timeInTitle[3];
                    }
                    
                    let dueDate: string;
                    if (finalHours && finalMinutes) {
                        dueDate = `${date}T${finalHours}:${finalMinutes}:00`;
                    } else {
                        const now = new Date();
                        const taskDateObj = new Date(date);
                        
                        const isToday = taskDateObj.getFullYear() === now.getFullYear() &&
                                      taskDateObj.getMonth() === now.getMonth() &&
                                      taskDateObj.getDate() === now.getDate();
                        
                        if (isToday && now.getHours() >= 9) {
                            const futureTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
                            const h = String(futureTime.getHours()).padStart(2, '0');
                            const m = String(futureTime.getMinutes()).padStart(2, '0');
                            dueDate = `${date}T${h}:${m}:00`;
                        } else {
                            dueDate = `${date}T09:00:00`;
                        }
                    }

                    const existingReminders = await this.getReminders();
                    const existingReminder = existingReminders.find(r => {
                        const reminderTitle = r.title.trim();
                        const taskTitleTrimmed = finalTaskTitle.trim();
                        if (reminderTitle !== taskTitleTrimmed) return false;
                        if (!r.due) return false;
                        const reminderDate = r.due.split('T')[0];
                        return reminderDate === date;
                    });

                    if (existingReminder) {
                        if (isCompleted) {
                            await this.completeReminder(existingReminder.id);
                            console.log(`[ReminderSync] 标记提醒为完成: ${finalTaskTitle}`);
                        } else {
                            console.log(`[ReminderSync] ✅ 跳过已存在的提醒: ${finalTaskTitle} @${date}`);
                        }
                    } else if (!isCompleted) {
                        console.log(`[ReminderSync] ➕ 创建提醒: ${finalTaskTitle} @${date}${finalHours ? ' ' + finalHours + ':' + finalMinutes : ''}`);
                        await this.createReminder(finalTaskTitle.trim(), dueDate);
                        createdCount++;
                    }
                }
            }
        }

        if (!silent) {
            new Notice(`同步完成！创建 ${createdCount} 个提醒`);
        }
        console.log(`[ReminderSync] 日记到提醒同步完成: 创建 ${createdCount} 个提醒`);
    }

    async deleteReminder(id: string): Promise<boolean> {
        const script = `var Reminders=Application('Reminders');var r=Reminders.reminders.byId('${id}');r.delete();'ok';`;
        const result = await this.runJXA(script);
        return result !== null;
    }

    async createReminder(title: string, dueDate: string): Promise<boolean> {
        const script = `
var Reminders=Application('Reminders');
var list=Reminders.lists.whose({name:'${this.config.reminderListName}'})[0];
var r=Reminders.Reminder({name:'${title}',dueDate:new Date('${dueDate}')});
list.reminders.push(r);
'ok';
        `.replace(/\n/g, '');
        const result = await this.runJXA(script);
        return result !== null;
    }

    async completeReminder(id: string): Promise<boolean> {
        const script = `var Reminders=Application('Reminders');var r=Reminders.reminders.byId('${id}');r.completed=true;'ok';`;
        const result = await this.runJXA(script);
        return result !== null;
    }

    /**
     * 防抖同步文件
     */
    private debounceSyncFile(file: TFile) {
        const filePath = file.path;
        console.log(`[ReminderSync] debounceSyncFile 被调用: ${filePath}`);
        
        if (this.globalSyncing) {
            console.log(`[ReminderSync] ⏭️ 全局同步进行中，跳过单文件同步: ${filePath}`);
            return;
        }
        
        const existingTimer = this.syncDebounceTimers.get(filePath);
        if (existingTimer) {
            console.log(`[ReminderSync] 清除之前的防抖定时器: ${filePath}`);
            window.clearTimeout(existingTimer);
        }
        
        console.log(`[ReminderSync] ⏱️ 设置 3 秒防抖定时器: ${filePath}`);
        const timer = window.setTimeout(async () => {
            this.syncDebounceTimers.delete(filePath);
            
            console.log(`[ReminderSync] ⏰ 防抖定时器触发，开始双向同步: ${filePath}`);
            
            try {
                const content = await this.app.vault.read(file);
                if (/@\d{4}-\d{2}-\d{2}/.test(content)) {
                    console.log(`[ReminderSync] ✅ 文件包含日期格式任务，执行双向同步: ${filePath}`);
                    await this.syncFileWithReminders(file, content);
                } else {
                    console.log(`[ReminderSync] ⏭️ 文件不包含日期格式任务，跳过: ${filePath}`);
                }
            } catch (err) {
                console.error('[ReminderSync] 读取文件失败:', err);
            }
        }, 3000);
        
        this.syncDebounceTimers.set(filePath, timer);
    }

    /**
     * 文件与提醒事项的双向同步
     */
    async syncFileWithReminders(file: TFile, content: string): Promise<void> {
        console.log(`[ReminderSync] syncFileWithReminders 被调用: ${file.path}`);
        
        await this.withSyncLock('syncFileWithReminders', async () => {
            // 步骤1：同步提醒事项到日记
            console.log('[ReminderSync] 📥 步骤1: 同步提醒事项到日记');
            await this.syncRemindersToJournalInternal(true);
            
            // 步骤2：同步当前文件到提醒事项
            console.log('[ReminderSync] 📤 步骤2: 同步日记到提醒事项');
            await this.syncCurrentFileToRemindersInternal(file, content);
            
            console.log(`[ReminderSync] ✅ 双向同步完成: ${file.path}`);
        }, true); // skipIfBusy=true，如果锁被占用则跳过
    }

    /**
     * 同步当前文件的任务到提醒事项（内部实现）
     */
    private async syncCurrentFileToRemindersInternal(file: TFile, content: string): Promise<void> {
        const lines = content.split('\n');
        let hasTask = false;
        let createdCount = 0;
        let completedCount = 0;
        
        for (const line of lines) {
            const taskMatch = line.match(/^-\s+(?:\[([x\sX])\]|TODO|DONE)\s+(.+?)\s+@(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}))?/);
            
            if (taskMatch) {
                hasTask = true;
                const [, checkboxStatus, taskTitle, date, hours, minutes] = taskMatch;
                const isCompleted = checkboxStatus === 'x' || checkboxStatus === 'X' || line.includes('DONE');
                
                const taskDate = new Date(date);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                
                if (taskDate < today) {
                    continue;
                }
                
                let finalTaskTitle = taskTitle;
                let finalHours = hours;
                let finalMinutes = minutes;
                
                const timeInTitle = taskTitle.match(/^(\d{2}):(\d{2})\s+(.+)/);
                if (timeInTitle && !hours) {
                    finalHours = timeInTitle[1];
                    finalMinutes = timeInTitle[2];
                    finalTaskTitle = timeInTitle[3];
                }
                
                let dueDate: string;
                if (finalHours && finalMinutes) {
                    dueDate = `${date}T${finalHours}:${finalMinutes}:00`;
                } else {
                    const now = new Date();
                    const taskDateObj = new Date(date);
                    
                    const isToday = taskDateObj.getFullYear() === now.getFullYear() &&
                                  taskDateObj.getMonth() === now.getMonth() &&
                                  taskDateObj.getDate() === now.getDate();
                    
                    if (isToday && now.getHours() >= 9) {
                        const futureTime = new Date(now.getTime() + 3 * 60 * 60 * 1000);
                        const h = String(futureTime.getHours()).padStart(2, '0');
                        const m = String(futureTime.getMinutes()).padStart(2, '0');
                        dueDate = `${date}T${h}:${m}:00`;
                    } else {
                        dueDate = `${date}T09:00:00`;
                    }
                }
                
                const existingReminders = await this.getReminders();
                const existingReminder = existingReminders.find(r => {
                    const reminderTitle = r.title.trim();
                    const taskTitleTrimmed = finalTaskTitle.trim();
                    if (reminderTitle !== taskTitleTrimmed) return false;
                    if (!r.due) return false;
                    const reminderDate = r.due.split('T')[0];
                    const isMatch = reminderDate === date;
                    
                    console.log(`[ReminderSync] 比较提醒: "${reminderTitle}"`);
                    console.log(`  - 提醒日期: ${reminderDate} (原始: ${r.due})`);
                    console.log(`  - 任务日期: ${date}`);
                    console.log(`  - 匹配结果: ${isMatch}`);
                    
                    return isMatch;
                });
                
                if (existingReminder) {
                    if (isCompleted) {
                        await this.completeReminder(existingReminder.id);
                        completedCount++;
                        console.log(`[ReminderSync] 标记提醒为完成: ${finalTaskTitle}`);
                    } else {
                        console.log(`[ReminderSync] ✅ 跳过已存在的提醒: ${finalTaskTitle} @${date}`);
                    }
                } else if (!isCompleted) {
                    console.log(`[ReminderSync] ➕ 创建提醒: ${finalTaskTitle} @${date}`);
                    await this.createReminder(finalTaskTitle.trim(), dueDate);
                    createdCount++;
                }
            }
        }
        
        if (hasTask) {
            console.log(`[ReminderSync] 已同步文件: ${file.path}`);
            
            // 反向同步：将提醒事项中已完成的任务标记到笔记中
            let markedDoneCount = 0;
            const allReminders = await this.getReminders();
            const completedReminders = allReminders.filter(r => r.completed);
            
            if (completedReminders.length > 0) {
                let updatedContent = content;
                let contentChanged = false;
                
                for (const reminder of completedReminders) {
                    if (!reminder.due) continue;
                    
                    const reminderDate = reminder.due.split('T')[0];
                    const reminderTitle = reminder.title;
                    
                    const taskPattern = new RegExp(
                        `^(-\\s+(?:\\[\\s\\]|TODO))\\s+(.+?)\\s+@${reminderDate.replace(/[-]/g, '\\-')}(?:\\s+\\d{2}:\\d{2})?$`,
                        'gm'
                    );
                    
                    updatedContent = updatedContent.replace(taskPattern, (match, prefix, taskTitle) => {
                        let cleanTitle = taskTitle.trim();
                        const timeMatch = cleanTitle.match(/^(\d{2}):(\d{2})\s+(.+)/);
                        if (timeMatch) {
                            cleanTitle = timeMatch[3];
                        }
                        
                        if (cleanTitle === reminderTitle) {
                            contentChanged = true;
                            markedDoneCount++;
                            return match.replace(/^-\s+(?:\[\s\]|TODO)/, '- DONE');
                        }
                        return match;
                    });
                }
                
                if (contentChanged) {
                    await this.app.vault.modify(file, updatedContent);
                    console.log(`[ReminderSync] 标记 ${markedDoneCount} 个任务为已完成`);
                }
            }
            
            if (this.config.notifyOnSync && (createdCount > 0 || completedCount > 0 || markedDoneCount > 0)) {
                let message = '';
                if (createdCount > 0) {
                    message += `创建 ${createdCount} 个提醒`;
                }
                if (completedCount > 0) {
                    if (message) message += '，';
                    message += `完成 ${completedCount} 个提醒`;
                }
                if (markedDoneCount > 0) {
                    if (message) message += '，';
                    message += `标记 ${markedDoneCount} 个任务为完成`;
                }
                new Notice(`同步完成：${message}`);
            }
        }
    }

    async syncAccountingToJournal(date: string, entries: AccountingEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            const records = entries.map(entry => {
                const { expenseEmoji } = this.config;
                if (entry.amount === 0) {
                    return `- ${expenseEmoji}${entry.keyword} ${entry.description}`;
                }
                return `- ${expenseEmoji}${entry.keyword} ${entry.amount}${entry.description ? ' ' + entry.description : ''}`;
            });

            if (file instanceof TFile) {
                let content = await this.app.vault.read(file);
                const newRecords: string[] = [];
                
                for (const record of records) {
                    if (!content.includes(record)) {
                        newRecords.push(record);
                    }
                }
                
                if (newRecords.length === 0) {
                    console.log(`[ReminderSync] ${date} 的记账记录已存在，跳过`);
                    return true;
                }
                
                const lines = content.split('\n');
                while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                    lines.pop();
                }
                
                let newContent = lines.join('\n');
                if (newContent.length > 0) {
                    newContent += '\n' + newRecords.join('\n');
                } else {
                    newContent = newRecords.join('\n');
                }
                
                await this.app.vault.modify(file, newContent);
                console.log(`[ReminderSync] 更新 ${date} 日记，添加 ${newRecords.length} 条记账记录`);
            } else {
                await this.app.vault.create(journalPath, records.join('\n'));
                console.log(`[ReminderSync] 创建 ${date} 日记，添加 ${records.length} 条记账记录`);
            }
            
            return true;
        } catch (error) {
            console.error(`[ReminderSync] 同步记账到 ${date} 失败:`, error);
            return false;
        }
    }

    async syncHabitsToJournal(date: string, entries: HabitEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            const { habitPrefix = '#' } = this.config;
            
            const records = entries.map(entry => {
                return `- ${habitPrefix}${entry.habitKey} ${entry.description}`;
            });

            if (file instanceof TFile) {
                let content = await this.app.vault.read(file);
                const newRecords: string[] = [];
                
                for (const record of records) {
                    if (!content.includes(record)) {
                        newRecords.push(record);
                    }
                }
                
                if (newRecords.length === 0) {
                    console.log(`[ReminderSync] ${date} 的打卡记录已存在，跳过`);
                    return true;
                }
                
                const lines = content.split('\n');
                while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                    lines.pop();
                }
                
                let newContent = lines.join('\n');
                if (newContent.length > 0) {
                    newContent += '\n' + newRecords.join('\n');
                } else {
                    newContent = newRecords.join('\n');
                }
                
                await this.app.vault.modify(file, newContent);
                console.log(`[ReminderSync] 更新 ${date} 日记，添加 ${newRecords.length} 条打卡记录`);
            } else {
                await this.app.vault.create(journalPath, records.join('\n'));
                console.log(`[ReminderSync] 创建 ${date} 日记，添加 ${records.length} 条打卡记录`);
            }
            
            return true;
        } catch (error) {
            console.error(`[ReminderSync] 同步打卡到 ${date} 失败:`, error);
            return false;
        }
    }

    async syncVideosToJournal(date: string, entries: VideoEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            const records = entries.map(entry => {
                if (entry.title) {
                    return `- #${entry.typeKey} 《${entry.title}》${entry.comment ? ' ' + entry.comment : ''}`;
                } else {
                    return `- #${entry.typeKey} ${entry.comment}`;
                }
            });

            if (file instanceof TFile) {
                let content = await this.app.vault.read(file);
                const newRecords: string[] = [];
                
                for (const record of records) {
                    if (!content.includes(record)) {
                        newRecords.push(record);
                    }
                }
                
                if (newRecords.length === 0) {
                    console.log(`[ReminderSync] ${date} 的视频记录已存在，跳过`);
                    return true;
                }
                
                const lines = content.split('\n');
                while (lines.length > 0 && (lines[lines.length - 1].trim() === '' || lines[lines.length - 1].trim() === '-')) {
                    lines.pop();
                }
                
                let newContent = lines.join('\n');
                if (newContent.length > 0) {
                    newContent += '\n' + newRecords.join('\n');
                } else {
                    newContent = newRecords.join('\n');
                }
                
                await this.app.vault.modify(file, newContent);
                console.log(`[ReminderSync] 更新 ${date} 日记，添加 ${newRecords.length} 条视频记录`);
            } else {
                await this.app.vault.create(journalPath, records.join('\n'));
                console.log(`[ReminderSync] 创建 ${date} 日记，添加 ${records.length} 条视频记录`);
            }
            
            return true;
        } catch (error) {
            console.error(`[ReminderSync] 同步视频到 ${date} 失败:`, error);
            return false;
        }
    }
}
