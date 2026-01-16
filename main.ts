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

export default class ReminderSyncPlugin extends Plugin {
    config: ReminderSyncConfig;
    syncIntervalId: number | null = null;

    async onload() {
        console.log('加载提醒事项记账同步插件');

        // 检查是否为 macOS
        if (!Platform.isMacOS) {
            new Notice('提醒事项记账同步插件仅支持 macOS 系统');
            return;
        }

        // 加载配置
        await this.loadConfig();

        // 添加命令：手动同步
        this.addCommand({
            id: 'sync-reminders-to-journal',
            name: '同步提醒事项到日记',
            callback: () => this.syncRemindersToJournal()
        });

        // 添加命令：查看待同步提醒
        this.addCommand({
            id: 'preview-sync-reminders',
            name: '预览待同步的提醒事项',
            callback: () => this.previewSyncReminders()
        });

        // 如果启用自动同步，启动定时任务
        if (this.config.autoSync) {
            this.startAutoSync();
        }

        // 插件加载时异步执行一次同步（不阻塞加载）
        setTimeout(() => {
            console.log('[ReminderSync] 插件加载完成，开始后台同步...');
            this.syncRemindersToJournal(true).catch(err => {
                console.error('[ReminderSync] 后台同步失败:', err);
            });
        }, 1000); // 延迟1秒执行，确保不影响启动
    }

    async onunload() {
        console.log('卸载提醒事项记账同步插件');
        this.stopAutoSync();
    }

    // 加载配置
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

    // 启动自动同步
    startAutoSync() {
        if (this.syncIntervalId) return;
        
        console.log(`启动自动同步，间隔: ${this.config.syncInterval}ms`);
        this.syncIntervalId = window.setInterval(
            () => this.syncRemindersToJournal(true),
            this.config.syncInterval
        );
    }

    // 停止自动同步
    stopAutoSync() {
        if (this.syncIntervalId) {
            window.clearInterval(this.syncIntervalId);
            this.syncIntervalId = null;
            console.log('停止自动同步');
        }
    }

    // 执行 JXA 脚本
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

    // 获取提醒事项
    async getReminders(): Promise<Reminder[]> {
        const script = `
var Reminders=Application('Reminders');
var result=[];
var lists=Reminders.lists();
var listCount=lists.length;
for(var i=0;i<listCount;i++){
    var list=lists[i];
    var listName=list.name();
    if(listName!=='${this.config.reminderListName}')continue;
    var reminders=list.reminders.whose({completed:false})();
    var reminderCount=reminders.length;
    for(var j=0;j<reminderCount;j++){
        var r=reminders[j];
        var item={title:r.name(),id:r.id(),list:listName};
        var dueDate=r.dueDate();
        if(dueDate&&dueDate.toString()!=='missing value'){
            item.due=dueDate.toISOString();
        }
        result.push(item);
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

    // 解析提醒事项标题，提取记账信息
    parseReminderTitle(title: string): AccountingEntry | null {
        const { categories, expenseEmoji, smartKeywords } = this.config;
        
        // 检查是否包含数字（必须有数字才认为是记账提醒）
        if (!/\d/.test(title)) {
            return null;
        }
        
        // 方式1：标准格式 - 包含记账标识符和关键词
        if (title.includes(expenseEmoji)) {
            // 创建关键词列表，按长度排序
            const keywords = Object.keys(categories).sort((a, b) => b.length - a.length);
            const keywordPattern = keywords.join('|');
            
            // 提取记账信息：#关键词 金额 描述（支持无空格格式）
            // 匹配格式：#cy 50 描述 或 #cy50描述 或 #cy全家早餐100元买了3个鸡蛋
            // 使用非贪婪匹配 .*? 找到第一个数字作为金额
            const regex = new RegExp(`${expenseEmoji}\\s*(${keywordPattern})\\s*(.*?)([\\d.]+)(.*)`, 'g');
            const match = regex.exec(title);
            
            if (match) {
                const [, keyword, prefix, amount, suffix] = match;
                const category = categories[keyword] || '未分类';
                
                // 合并前缀和后缀作为完整描述
                const description = (prefix + suffix).trim();
                
                return {
                    keyword,
                    category,
                    amount: parseFloat(amount),
                    description: description,
                    date: '',
                    reminderId: ''
                };
            }
        }
        
        // 方式2：智能识别 - 通过关键词自动识别分类
        if (smartKeywords) {
            for (const [keyword, triggers] of Object.entries(smartKeywords)) {
                // 检查标题是否包含任何触发词
                const hasTrigger = triggers.some(trigger => title.includes(trigger));
                
                if (hasTrigger) {
                    const category = categories[keyword] || '未分类';
                    
                    // 智能识别的记账，整个标题作为描述
                    return {
                        keyword,
                        category,
                        amount: 0, // 金额为0，表示需要手动补充
                        description: title,
                        date: '',
                        reminderId: ''
                    };
                }
            }
        }
        
        return null;
    }

    // 解析打卡提醒
    parseHabitReminder(title: string): HabitEntry | null {
        const { habits, habitKeywords } = this.config;
        
        if (!habits || !habitKeywords) {
            return null;
        }
        
        // 智能识别打卡类型
        for (const [habitKey, triggers] of Object.entries(habitKeywords)) {
            // 检查标题是否包含任何触发词
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

    // 解析视频提醒
    parseVideoReminder(title: string): VideoEntry | null {
        const { videoTypes, videoKeywords } = this.config;
        
        if (!videoTypes || !videoKeywords) {
            return null;
        }
        
        // 智能识别视频类型
        for (const [typeKey, triggers] of Object.entries(videoKeywords)) {
            // 检查标题是否包含任何触发词
            const hasTrigger = triggers.some(trigger => title.includes(trigger));
            
            if (hasTrigger) {
                const typeName = videoTypes[typeKey];
                
                // 提取视频名称和评论
                let videoTitle = '';
                let comment = '';
                
                // 如果有《》包裹的标题
                const titleMatch = title.match(/《([^》]+)》/);
                if (titleMatch) {
                    videoTitle = titleMatch[1];
                    comment = title.replace(titleMatch[0], '').trim();
                } else {
                    // 否则整个标题作为评论
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

    // 预览待同步的提醒事项
    async previewSyncReminders() {
        new Notice('正在读取提醒事项...');
        
        const reminders = await this.getReminders();
        if (reminders.length === 0) {
            new Notice('未找到提醒事项');
            return;
        }

        // 筛选出包含记账标签的提醒
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

        // 显示预览信息
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

    // 同步提醒事项到日记
    async syncRemindersToJournal(silent = false) {
        if (!silent) {
            new Notice('开始同步提醒事项...');
        }
        
        const reminders = await this.getReminders();
        if (reminders.length === 0) {
            if (!silent) {
                new Notice('未找到提醒事项');
            }
            return;
        }

        // 筛选并解析记账提醒、打卡提醒和视频提醒
        const accountingEntries: Array<{ reminder: Reminder; entry: AccountingEntry }> = [];
        const habitEntries: Array<{ reminder: Reminder; entry: HabitEntry }> = [];
        const videoEntries: Array<{ reminder: Reminder; entry: VideoEntry }> = [];
        
        for (const reminder of reminders) {
            // 先尝试解析为记账提醒（包含数字）
            const accountingEntry = this.parseReminderTitle(reminder.title);
            if (accountingEntry) {
                accountingEntry.date = reminder.due 
                    ? formatLocalDate(new Date(reminder.due))
                    : formatLocalDate(new Date());
                accountingEntry.reminderId = reminder.id;
                accountingEntries.push({ reminder, entry: accountingEntry });
                continue;
            }
            
            // 再尝试解析为视频提醒
            const videoEntry = this.parseVideoReminder(reminder.title);
            if (videoEntry) {
                videoEntry.date = reminder.due 
                    ? formatLocalDate(new Date(reminder.due))
                    : formatLocalDate(new Date());
                videoEntry.reminderId = reminder.id;
                videoEntries.push({ reminder, entry: videoEntry });
                continue;
            }
            
            // 最后尝试解析为打卡提醒
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

    // 删除提醒事项
    async deleteReminder(id: string): Promise<boolean> {
        const script = `var Reminders=Application('Reminders');var r=Reminders.reminders.byId('${id}');r.delete();'ok';`;
        const result = await this.runJXA(script);
        return result !== null;
    }

    // 同步记账到指定日期的日记
    async syncAccountingToJournal(date: string, entries: AccountingEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            // 构建记账记录
            const records = entries.map(entry => {
                const { expenseEmoji } = this.config;
                // 如果金额为0（智能识别的），只记录关键词和描述
                if (entry.amount === 0) {
                    return `- ${expenseEmoji}${entry.keyword} ${entry.description}`;
                }
                // 标准格式：关键词 金额 描述
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

    // 同步打卡到指定日期的日记
    async syncHabitsToJournal(date: string, entries: HabitEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            const { habitPrefix = '#' } = this.config;
            
            // 构建打卡记录
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

    // 同步视频到指定日期的日记
    async syncVideosToJournal(date: string, entries: VideoEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            // 构建视频记录
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
