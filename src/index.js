const Slack = require('slack');
const Airtable = require('airtable');
const Task = require('./task');

const { getCoords, distanceBetweenCoords } = require('./geo');
require('dotenv').config();

/* System notes:
 * - Certain tasks should probably have an unmatchable requirement (because the tasks requires
 *   looking a shortlist of specialized volunteers)
 * - Airtable fields that start with '_' are system columns, not to be updated manually
 * - If the result seems weird, verify the addresses of the request/volunteers
*/

// Airtable
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base('appwgY1BPRGt1RBbE');

const token = process.env.SLACK_XOXB;
const channel = process.env.SLACK_CHANNEL_ID;
const bot = new Slack({ token });

// This function actually sends the message to the slack channel
const sendMessage = (errand, task, vols) => bot.chat
  .postMessage({
    token,
    channel,
    text: '',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':exclamation: *A new errand has been added!* :exclamation:',
        },
      },
      errand,
      task,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ' ',
        },
      },
    ],
    attachments: [
      {
        blocks: vols,
      },
    ],
  });

// Gets list of tasks from spreadsheet and adds to message text
function formatTasks(row) {
  let formattedTasks = '';

  const tasks = row.get('Tasks');
  if (tasks) {
    formattedTasks = row.get('Tasks').reduce((msg, task) => `${msg}\n :small_orange_diamond: ${task}`, '');
  }

  return formattedTasks;
}


function log(s) {
  console.log('\x1b[33m%s\x1b[0m', s);
}

function fullAddress(record) {
  return `${record.get('Address')} ${record.get('City')}, NY`;
}

// Accepts errand address and checks volunteer spreadsheet for closest volunteers
async function findVolunteers(request) {
  const volunteerDistances = [];

  const tasks = request.get('Tasks').map(Task.mapFromRawTask) || [];
  const errandCoords = await getCoords(fullAddress(request));

  console.log(`Tasks: ${tasks.map((task) => task.rawTask).join(', ')}`);

  // Figure out which volunteers can fulfill at least one of the tasks
  await base('Volunteers (real)').select({ view: 'Grid view' }).eachPage(async (volunteers, nextPage) => {
    const suitableVolunteers = volunteers.filter((volunteer) => tasks
      .some((task) => task.canBeFulfilledByVolunteer(volunteer)));

    // Calculate the distance to each volunteer
    for (const volunteer of suitableVolunteers) {
      const volAddress = volunteer.get('Full Street address (You can leave out your apartment/unit.)') || '';

      // Check if we need to retrieve the addresses coordinates
      // NOTE: We do this to prevent using up our free tier queries on Mapquest (15k/month)
      if (volAddress !== volunteer.get('_coordinates_address')) {
        let newVolCoords;
        try {
          newVolCoords = await getCoords(volAddress);
        } catch (e) {
          console.log('Unable to retrieve volunteer coordinates:', volunteer.get('Full Name'));
          // eslint-disable-next-line no-continue
          continue;
        }

        volunteer.patchUpdate({
          '_coordinates': JSON.stringify(newVolCoords),
          '_coordinates_address': volAddress,
        });
        volunteer.fetch();
      }

      // Try to get coordinates for this volunteer
      let volCoords;
      try {
        volCoords = JSON.parse(volunteer.get('_coordinates'));
      } catch (e) {
        console.log('Unable to parse volunteer coordinates:', volunteer.get('Full Name'));
        // eslint-disable-next-line no-continue
        continue;
      }

      // Calculate the distance
      const distance = distanceBetweenCoords(volCoords, errandCoords);
      volunteerDistances.push([volunteer, distance]);
    }

    nextPage();
  });

  // Sort the volunteers by distance and grab the closest 10
  const closestVolunteers = volunteerDistances.sort((a, b) => a[1] - b[1])
    .slice(0, 10)
    .map((volunteerAndDistance) => {
      const [volunteer, distance] = volunteerAndDistance;
      return {
        Name: volunteer.get('Full Name'),
        Number: volunteer.get('Please provide your contact phone number:'),
        Distance: distance,
        record: volunteer,
      };
    });

  console.log('Closest:');
  closestVolunteers.forEach((v) => {
    console.log(v.Name, v.Distance.toFixed(2), 'Mi');
  });

  return closestVolunteers;
}

// Checks for updates on errand spreadsheet, finds closest volunteers from volunteer spreadsheet and
// executes slack message if new row has been detected
async function checkForNewSubmissions() {
  base('Requests').select({ view: 'Grid view' }).eachPage(async (records, nextPage) => {
    // Look for records that have not been posted to slack yet
    for (const record of records) {
      if (record.get('Posted to Slack?') !== 'yes') {
        log(`\nProcessing: ${record.get('Name')}`);

        // Prepare the general info
        const profileURL = `https://airtable.com/tblaL1g6IzH6uPclD/viwEjCF8PkEfQiLFC/${record.id}`;
        const header = [
          `<${profileURL}|${record.get('Name')}>`,
          record.get('Phone number'),
          record.get('Address'),
        ];
        const errandObject = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: header.join('\n'),
          },
        };

        // Process the requested tasks
        const taskObject = {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*Needs assistance with:*${formatTasks(record)}`,
          },
        };

        // Find the closest volunteers
        const volObject = [];
        const volunteers = await findVolunteers(record);
        if (volunteers.length > 0) {
        // Header
          volObject.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*Here are the 10 closest volunteers*',
            },
          });

          // Prepare the verbose volunteer info
          volunteers.forEach((volunteer) => {
            const volunteerURL = `https://airtable.com/tblxqtMAabmJyl98c/viwNYMdylPukGiOYQ/${volunteer.record.id}`;
            volObject.push({
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `<${volunteerURL}|${volunteer.Name}> - ${volunteer.Number} - ${volunteer.Distance.toFixed(2)} Mi.`,
              },
            });
          });

          const msg = 'Here are the volunteer phone numbers for easy copy/pasting:';
          volObject.push({
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: [msg].concat(volunteers.map((v) => v.Number)).join('\n'),
            },
          });
        } else {
        // No volunteers found
          volObject.push({
            type: 'section',
            text: { type: 'mrkdwn', text: '*No volunteers match this request!*\n*Check the full Airtable record, there might be more info there.*' },
          });
        }

        // Post the message to Slack
        const slackRes = await sendMessage(
          errandObject,
          taskObject,
          volObject,
        );
        console.log(slackRes);
        await record
          .patchUpdate({
            'Posted to Slack?': 'yes',
            'Status': record.get('Status') || 'Needs assigning', // don't overwrite the status
          })
          .then(console.log('Updated record!'))
          .catch((error) => console.log(error));
      }
    }

    nextPage();
  });
}

async function start() {
  try {
    console.log('Volunteer Dispatch started!');
    checkForNewSubmissions();
    setInterval(checkForNewSubmissions, 20000);
  } catch (error) {
    console.log(error);
  }
}

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', reason);
  // application specific logging, throwing an error, or other logic here
});

start();
