-- Hand-written sample in the shape of Module:Codename/data/rel: subpages
-- pulled in with require(), and inline entries.
return {
  {
	id = 'FFIIHnD',
	title = 'Final Fantasy II Hihō no Dragon',
	media = 'text',
	sub = 'FFII',
	files = { shorthand = 'Hihō no Dragon' },
  },
  require("Module:Codename/data/rel/FFVI"),
  require("Module:Codename/data/rel/FFVII"),
  {
	id = 'FFVIIR',
	title = 'Final Fantasy VII Remake',
	media = 'game',
	versions = {
	    ['intergrade'] = {
	        name = 'Intergrade',
	    },
	},
	files = { shorthand = 'FFVII Remake', versionneutral = true },
  },
  {
	id = 'VIICC',
	title = 'Crisis Core -Final Fantasy VII-',
	media = 'game',
	sub = 'FFVII',
	files = { shorthand = 'Crisis Core' },
  },
  {
	id = 'VIIRToTP',
	title = 'Final Fantasy VII Remake Trace of Two Pasts',
	media = 'text',
	sub = 'FFVII, VIIrp',
	files = { shorthand = 'Trace of Two Pasts', versionneutral = true },
  },
  {
	id = 'FFX',
	title = 'Final Fantasy X',
	media = 'game',
	terms = {},
	versions = {
	    ['international'] = {
	        name = 'International',
	    },
	    ['hd remaster'] = {
	        name = 'HD Remaster',
	        files = { shorthand = 'HD' },
	    },
	},
  },
  {
	id = 'XIV1',
	title = 'Final Fantasy XIV',
	media = 'game',
	sub = 'false',
	files = { shorthand = 'FFXIV 1.0' },
  },
}
