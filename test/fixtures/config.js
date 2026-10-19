/* MagicMirror config — DAKboard replacement (top-down layout)
 *
 *   time (top left)                [next NFL game]                date (top right)
 *   ------------------------------------------------------------------------------
 *   calendar: 2-week grid
 *   ------------------------------------------------------------------------------
 *   weather: current conditions + 5-day forecast
 *   Google Photos slideshow behind everything, thin progress bar along the bottom
 *
 * Things to fill in are marked  >>> CHANGE <<<.
 * Settings can also be changed from a browser at http://<mirror-ip>:8080/MMM-ConfigEditor/
 * (it edits this file in place and keeps these comments).
 */
let config = {
	address: "0.0.0.0", // listen on the network so the setup and configure pages open from your phone/PC
	port: 8080,
	basePath: "/",
	ipWhitelist: [], // [] = any device on your home network. Don't forward this port on your router.

	useHttps: false,
	language: "en",
	locale: "en-US",
	timeFormat: 12, // 12 or 24
	units: "imperial", // "imperial" or "metric"

	logLevel: ["INFO", "LOG", "WARN", "ERROR"],

	modules: [
		/* ---------- Time, top left ---------- */
		{
			module: "clock",
			position: "top_left",
			classes: "hb-time",
			config: {
				displayType: "digital", // "digital" or "analog"
				timezone: "America/New_York", // >>> CHANGE <<< if needed (IANA name)
				showDate: false,
				displaySeconds: false,
				showPeriod: true, // AM/PM (12-hour only)
				showPeriodUpper: true,
				analogSize: "220px",
				analogFace: "face-001"
			}
		},

		/* ---------- Date, top right ---------- */
		{
			module: "clock",
			position: "top_right",
			classes: "hb-date",
			config: {
				timezone: "America/New_York", // keep the same as the time clock
				showTime: false,
				showDate: true,
				dateFormat: "dddd, MMMM D" // "Sunday, October 18"; use "dddd, D MMMM" for "Sunday, 18 October"
			}
		},

		/* ---------- NFL: record + next game, top center ---------- */
		{
			module: "MMM-MyScoreboard",
			position: "top_center",
			classes: "hb-nfl",
			config: {
				viewStyle: "mediumLogos", // logos + quarter/clock, or kickoff time and network; record under each logo
				showUpcomingGames: true, // next game when there's no game today
				showRecord: true, // added by our patch (see patches/README.md)
				hideBroadcasts: false,
				sports: [
					{ league: "NFL", teams: ["CIN"] } // >>> CHANGE <<< your team's abbreviation (CIN, CLE, PIT, ...)
				]
			}
		},

		/* ---------- Calendar feeds (no position: it only feeds the grid below) ---------- */
		{
			module: "calendar",
			config: {
				broadcastPastEvents: true, // so earlier days in the current week still show their events
				maximumEntries: 300,
				maximumNumberOfDays: 35,
				fetchInterval: 5 * 60 * 1000,
				calendars: [
					// >>> CHANGE <<< paste each Google Calendar's "Secret address in iCal format"
					// (the same private .ics links DAKboard uses). Add one block per calendar.
					{
						name: "family",
						url: "https://calendar.google.com/calendar/ical/REPLACE_ME/basic.ics",
						color: "#4fc3f7",
						symbol: "calendar"
					},
					{
						name: "work",
						url: "https://calendar.google.com/calendar/ical/REPLACE_ME_TOO/basic.ics",
						color: "#f6bf26",
						symbol: "briefcase"
					}
				]
			}
		},

		/* ---------- Calendar grid ---------- */
		{
			module: "MMM-CalendarExt3",
			position: "upper_third",
			classes: "hb-calendar",
			config: {
				instanceId: "homeCalendar",
				mode: "week",
				weekIndex: 0, // start with the current week
				weeksInView: 2, // 1, 2, 3 or 4
				firstDayOfWeek: 0, // 0 = Sunday, 1 = Monday
				locale: "en-US",
				// Event lines per day, by number of weeks shown ([default, 1 week, 2, 3, 4]),
				// so the grid fills the space between the header and the weather.
				maxEventLines: [4, 16, 8, 5, 3],
				fontSize: "19px",
				eventHeight: "29px",
				useWeather: false,
				useSymbol: false,
				showMore: true,
				showWeekNumber: false,
				headerWeekDayOptions: { weekday: "short" },
				cellDateOptions: { day: "numeric" },
				eventTimeOptions: { hour: "numeric", minute: "2-digit" },
				refreshInterval: 5 * 60 * 1000
			}
		},

		/* ---------- Weather strip, bottom ---------- */
		{
			module: "MMM-NWSWeatherStrip",
			position: "bottom_bar",
			classes: "hb-weather",
			config: {
				lat: 39.7589, // >>> CHANGE <<< your latitude
				lon: -84.1916, // >>> CHANGE <<< your longitude
				days: 5, // 1, 3 or 5
				units: "imperial",
				showCurrent: true,
				contact: "" // >>> CHANGE <<< your email; NWS asks apps to include a contact
			}
		},

		/* ---------- Google Photos background ---------- */
		{
			module: "MMM-GooglePhotosPicker",
			position: "fullscreen_below",
			config: {
				// Add photos at http://<mirror-ip>:8080/MMM-GooglePhotosPicker/
				interval: "2m", // 15s 30s 1m 2m 3m 5m 10m 15m 30m 1h 2h 4h daily
				transition: "fade", // fade, slide, zoom, none
				transitionDuration: 1500,
				fit: "cover", // cover (fill screen) or contain (whole photo)
				shuffle: true,
				showDateTaken: true,
				showCamera: false,
				captionPosition: "bottom-left",
				showProgressBar: true,
				dimming: 0.2
			}
		},

		/* ---------- Settings page: http://<mirror-ip>:8080/MMM-ConfigEditor/ ---------- */
		{
			module: "MMM-ConfigEditor",
			config: {
				restart: "exit" // MagicMirror quits after a save; the kiosk script (or pm2) starts it again
			}
		}
	]
};

/*************** DO NOT EDIT THE LINE BELOW ***************/
if (typeof module !== "undefined") { module.exports = config; }
