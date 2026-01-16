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
            console.error('加载配置失败，使用默认配置:', error);
            this.config = {
                appName: '提醒事项记账同步',
                categories: {
                    'cy': '餐饮',
                    'jt': '交通',
                    'yl': '娱乐',
                    'gw': '购物',
                    'yy': '医疗',
                    'jy': '教育',
                    'fz': '房租',
                    'qt': '其他',
                    'sr': '收入'
                },
                expenseEmoji: '💰',
                journalsPath: 'journals',
                reminderListName: 'Inbox',
                autoSync: false,
                syncInterval: 300000
            };
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
        const { categories, expenseEmoji } = this.config;
        
        // 检查是否包含记账表情符号
        if (!title.includes(expenseEmoji)) {
            return null;
        }

        // 创建关键词列表，按长度排序
        const keywords = Object.keys(categories).sort((a, b) => b.length - a.length);
        const keywordPattern = keywords.join('|');
        
        // 提取记账信息：💰关键词 金额 描述
        const regex = new RegExp(`${expenseEmoji}\\s*(${keywordPattern})\\s+([\\d.]+)\\s*(.*)`, 'g');
        const match = regex.exec(title);
        
        if (!match) return null;

        const [, keyword, amount, description] = match;
        const category = categories[keyword] || '未分类';
        
        return {
            keyword,
            category,
            amount: parseFloat(amount),
            description: description.trim(),
            date: '',
            reminderId: ''
        };
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

        // 筛选并解析记账提醒
        const accountingEntries: Array<{ reminder: Reminder; entry: AccountingEntry }> = [];
        
        for (const reminder of reminders) {
            const entry = this.parseReminderTitle(reminder.title);
            if (!entry) continue;
            
            // 使用提醒的到期日期，如果没有则使用今天
            entry.date = reminder.due 
                ? formatLocalDate(new Date(reminder.due))
                : formatLocalDate(new Date());
            entry.reminderId = reminder.id;
            
            accountingEntries.push({ reminder, entry });
        }

        if (accountingEntries.length === 0) {
            if (!silent) {
                new Notice('未找到包含记账标签的提醒事项');
            }
            return;
        }

        // 按日期分组
        const entriesByDate: Record<string, AccountingEntry[]> = {};
        for (const { entry } of accountingEntries) {
            if (!entriesByDate[entry.date]) {
                entriesByDate[entry.date] = [];
            }
            entriesByDate[entry.date].push(entry);
        }

        // 同步到对应日期的日记
        let syncCount = 0;
        for (const [date, entries] of Object.entries(entriesByDate)) {
            const success = await this.syncToJournal(date, entries);
            if (success) {
                syncCount += entries.length;
            }
        }

        if (!silent) {
            new Notice(`同步完成！共同步 ${syncCount} 条记账记录`);
        }
        
        console.log(`[ReminderSync] 同步完成: ${syncCount} 条记录`);
    }

    // 同步到指定日期的日记
    async syncToJournal(date: string, entries: AccountingEntry[]): Promise<boolean> {
        try {
            const journalPath = `${this.config.journalsPath}/${date}.md`;
            const file = this.app.vault.getAbstractFileByPath(journalPath);
            
            // 构建记账记录
            const records = entries.map(entry => {
                const { expenseEmoji } = this.config;
                return `- ${expenseEmoji}${entry.keyword} ${entry.amount}${entry.description ? ' ' + entry.description : ''}`;
            });

            if (file instanceof TFile) {
                // 文件存在，检查是否已经包含这些记录
                let content = await this.app.vault.read(file);
                const newRecords: string[] = [];
                
                for (const record of records) {
                    // 简单检查：如果内容中不包含这条记录，则添加
                    if (!content.includes(record)) {
                        newRecords.push(record);
                    }
                }
                
                if (newRecords.length === 0) {
                    console.log(`[ReminderSync] ${date} 的记录已存在，跳过`);
                    return true;
                }
                
                // 移除末尾的空行
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
                console.log(`[ReminderSync] 更新 ${date} 日记，添加 ${newRecords.length} 条记录`);
            } else {
                // 文件不存在，创建新文件
                await this.app.vault.create(journalPath, records.join('\n'));
                console.log(`[ReminderSync] 创建 ${date} 日记，添加 ${records.length} 条记录`);
            }
            
            return true;
        } catch (error) {
            console.error(`[ReminderSync] 同步到 ${date} 失败:`, error);
            return false;
        }
    }
}
