export namespace main {
	
	export class JournalFile {
	    path: string;
	    name: string;
	    content: string;
	    exists: boolean;
	    streamIndex: number;
	
	    static createFrom(source: any = {}) {
	        return new JournalFile(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.path = source["path"];
	        this.name = source["name"];
	        this.content = source["content"];
	        this.exists = source["exists"];
	        this.streamIndex = source["streamIndex"];
	    }
	}
	export class DayData {
	    date: string;
	    todo: JournalFile;
	    doing: JournalFile[];
	
	    static createFrom(source: any = {}) {
	        return new DayData(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.date = source["date"];
	        this.todo = this.convertValues(source["todo"], JournalFile);
	        this.doing = this.convertValues(source["doing"], JournalFile);
	    }
	
		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class DaySummary {
	    date: string;
	    doingCount: number;
	    hasTodo: boolean;
	
	    static createFrom(source: any = {}) {
	        return new DaySummary(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.date = source["date"];
	        this.doingCount = source["doingCount"];
	        this.hasTodo = source["hasTodo"];
	    }
	}
	
	export class SaveResult {
	    saved: boolean;
	    conflict: boolean;
	    content: string;
	    exists: boolean;
	
	    static createFrom(source: any = {}) {
	        return new SaveResult(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.saved = source["saved"];
	        this.conflict = source["conflict"];
	        this.content = source["content"];
	        this.exists = source["exists"];
	    }
	}
	export class Settings {
	    storageRoot: string;
	    editorFont: string;
	
	    static createFrom(source: any = {}) {
	        return new Settings(source);
	    }
	
	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.storageRoot = source["storageRoot"];
	        this.editorFont = source["editorFont"];
	    }
	}

}

