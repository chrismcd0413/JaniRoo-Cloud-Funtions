/* eslint-disable @typescript-eslint/no-non-null-assertion */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable no-constant-condition */
/* eslint-disable require-jsdoc */
/* eslint-disable max-len */
import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import moment from "moment-timezone";
// // Start writing Firebase Functions
// // https://firebase.google.com/docs/functions/typescript
admin.initializeApp();
admin.firestore().settings({ignoreUndefinedProperties: false});
export const createUser = functions.https.onCall((data) => {
  return admin
      .auth()
      .createUser(data)
      .catch((error) => {
        throw new functions.https.HttpsError("internal", error.message);
      });
});
export const resetPassword = functions.https.onCall((data) => {
  return admin.auth().updateUser(data.id, {
    password: data.password,
  });
});
export const updateUserStatus = functions.https.onCall((data) => {
  return admin.auth().updateUser(data.id, {
    disabled: data.disabled,
  });
});
// needs to be 0 * * * *
exports.createNextRecurringChecklist = functions.pubsub
    .schedule("0 * * * *")
    .onRun((context) => {
      const now = new Date(Date.parse(context.timestamp));
      const nowTs = admin.firestore.Timestamp.fromDate(now);
      admin
          .firestore()
          .collection("Active Checklists")
          .where("expiration", "<", nowTs)
          .where("complete", "==", false)
          .get()
          .then((snapshot) => {
            if (snapshot.size > 0) {
              snapshot.docs.forEach((checklist) => {
                completeChecklist(checklist);
              });
            }
          });
      return null;
    });
function completeChecklist(
    s: admin.firestore.QueryDocumentSnapshot<admin.firestore.DocumentData>
) {
  const data = s.data();
  const checklistTemplate = admin
      .firestore()
      .collection("Checklist Templates")
      .doc(data.templateId);
  let templateTzId;
  let templateData;
  let templateId;
  checklistTemplate.get().then((temp) => {
    templateData = temp.data();
    functions.logger.log("Got template: ", templateData);
    templateTzId = templateData.tzId;
    templateId = temp.id;
    const updateFields = {
      complete: true,
    };
    admin
        .firestore()
        .collection("Active Checklists")
        .doc(s.id)
        .update(updateFields);
    /* THIS IS WHERE THE MAGIC HAPPENS
     */

    let currentExpiration;
    let newExpiration;
    let dateRange;
    let timestamp;
    if (templateData.type === "Weekly") {
      const ts: admin.firestore.Timestamp = data.expiration;
      currentExpiration = moment(ts.toMillis()).tz(templateTzId);
      newExpiration = currentExpiration.clone().add(7, "days");
      const formattedDate = new Date(Date.parse(newExpiration.format()));
      dateRange =
        newExpiration.clone().subtract(1, "week").format("MM/DD") +
        " - " +
        newExpiration.clone().format("MM/DD");
      timestamp = admin.firestore.Timestamp.fromDate(formattedDate);
    } else if (templateData.type === "Monthly") {
      const ts: admin.firestore.Timestamp = data.expiration;
      currentExpiration = moment(ts.toMillis()).tz(templateTzId);
      newExpiration = currentExpiration.clone().add(1, "month");
      newExpiration.endOf("month");
      const formattedDate = new Date(Date.parse(newExpiration.format()));
      dateRange =
        newExpiration.clone().subtract(1, "week").format("MM/DD") +
        " - " +
        newExpiration.clone().format("MM/DD");
      timestamp = admin.firestore.Timestamp.fromDate(formattedDate);
    }
    const taskArray = [];
    templateData.tasks.forEach((x) => {
      const object = {
        id: generateRandomId(15),
        title: x.title,
        description: x.description,
        completed: false,
        subtasks: x.subtasks,
        templateId: x.id,
        photo_required: x.photo_required,
      };
      taskArray.push(object);
    });
    const activeChecklist = {
      companyId: templateData.companyId,
      location: templateData.location,
      tasks: taskArray,
      expiration: timestamp,
      date_range: dateRange,
      templateId: templateId,
      complete: false,
      title: templateData.title,
      type: templateData.type,
      query: generateQueryDateFirestore(timestamp.toMillis(), templateData.tzId),
      tzId: templateData.tzId,
    };
    return admin
        .firestore()
        .collection("Active Checklists")
        .doc()
        .set(activeChecklist);
  });
}

exports.updateHoursWorked = functions.firestore
    .document("Timesheets/{newId}")
    .onCreate((event, context) => {
      const data = event.data();
      if (data.clock_in_time && data.clock_out_time) {
        const inTime = data.clock_in_time.toMillis();
        const outTime = data.clock_out_time.toMillis();
        const inMoment = moment(inTime);
        const outMoment = moment(outTime);
        const hoursWorked =
        Math.round((outMoment.diff(inMoment, "minutes") / 60) * 100) / 100;
        return event.ref.update({hrs_worked: hoursWorked});
      } else {
        return null;
      }
    });
exports.updateHoursWorkedOnUpdate = functions.firestore
    .document("Timesheets/{tsId}")
    .onUpdate((event, context) => {
      const data = event.after.data();
      let queryStart;
      let queryEnd;
      let inTime;
      let outTime;
      let hoursWorked;
      return admin.firestore().collection("Accounts").doc(data.location.acct).get()
          .then((a) => {
            const location = a.data().locations.find((x) => x.id === data.location.loc);
            functions.logger.debug("Found Location: ", location);
            functions.logger.debug("Found Account: ", a.data());
            functions.logger.debug("Updated TS: ", data);
            if (data.clock_in_time) {
              queryStart = generateQueryDateFirestore(moment(data.clock_in_time.toMillis()), location.address.tzId);
            }
            if (data.clock_out_time) {
              queryEnd = generateQueryDateFirestore(moment(data.clock_out_time.toMillis()), location.address.tzId);
            }
            if (data.clock_in_time && data.clock_out_time) {
              inTime = data.clock_in_time.toMillis();
              outTime = data.clock_out_time.toMillis();
              const inMoment = moment(inTime);
              const outMoment = moment(outTime);
              hoursWorked =
              Math.round((outMoment.diff(inMoment, "minutes") / 60) * 100) / 100;
            }
            event.after.ref.update({hrs_worked: hoursWorked, query_start: queryStart, query_end: queryEnd});
          });
    });
exports.syncRecurringChecklists = functions.firestore
    .document("Checklist Templates/{templateId}")
    .onUpdate((checklist, context) => {
      const newChecklist = checklist.after.data();
      const oldChecklist = checklist.before.data();
      const newTaskList: any[] = newChecklist.tasks;
      const oldTaskList: any[] = oldChecklist.tasks;
      const checklistType = newChecklist.type;
      functions.logger.log("New Checklist: ", newChecklist);
      functions.logger.log("Old Checklist: ", newChecklist);
      if (checklistType != "Daily") {
        functions.logger.log("Starting Process");

        if (JSON.stringify(newTaskList) === JSON.stringify(oldTaskList)) {
          functions.logger.log("No Change to List");

          return null;
        } else {
          functions.logger.log("Starting Loop");
          functions.logger.log("Template ID: ", checklist.after.id);

          return admin
              .firestore()
              .collection("Active Checklists")
              .where("companyId", "==", checklist.after.data().companyId)
              .where("complete", "==", false)
              .where("templateId", "==", checklist.after.id)
              .get()
              .then((snapshot) => {
                functions.logger.log("Found snapshots: ", snapshot.docs);
                if (snapshot.size > 0) {
                  functions.logger.log("Active Checklists Found");

                  snapshot.docs.forEach((active) => {
                    const activeTasks: any[] = active.data().tasks;
                    const updatedArray: any[] = [];
                    // MAKE THE MAGIC HAPPEN
                    newTaskList.forEach((template) => {
                      const i = activeTasks.findIndex((z) => z.templateId === template.id);
                      functions.logger.log("Parsing Tmeplate Task: ", template);
                      if (i != -1) {
                        const currentTask = activeTasks.find((q) => q.templateId === template.id);
                        if (!currentTask.complete) {
                          const newTask = {
                            title: template.title,
                            description: template.description,
                            photo_required: template.photo_required,
                            subtasks: template.subtasks,
                            complete: false,
                            templateId: template.id,
                            id: generateRandomId(15),
                          };
                          updatedArray.push(newTask);
                        } else {
                          updatedArray.push(currentTask);
                        }
                      } else if (i == -1) {
                        const newTask = {
                          title: template.title,
                          description: template.description,
                          photo_required: template.photo_required,
                          subtasks: template.subtasks,
                          complete: false,
                          templateId: template.id,
                          id: generateRandomId(15),
                        };
                        updatedArray.push(newTask);
                      }
                    });
                    functions.logger.log("Near the end: ", updatedArray);
                    const removedButCompleted = activeTasks.filter((temp) => temp.complete === true);
                    const pushableArray = removedButCompleted.filter((temp) => newTaskList.findIndex((x) => temp.templateId === x.id) === -1);
                    functions.logger.log("Completed But Removed: ", pushableArray);
                    pushableArray.forEach((z) => updatedArray.push(z));
                    functions.logger.log("Pushing Final: ", updatedArray);
                    active.ref.update({tasks: updatedArray});
                  });
                }
              });
        }
      } else {
        return null;
      }
    });
exports.generateQueryArrayForSchedules = functions.firestore
    .document("Schedules/{scheduleId}")
    .onWrite((change, context) => {
      const document = change.after.exists ? change.after.data() : null;
      functions.logger.log("Document: ", document);
      if (document) {
        functions.logger.log("Made it to processing");
        const docPath = "Accounts/" + document.location.acct;
        return admin
            .firestore()
            .doc(docPath)
            .get()
            .then((account) => {
              const location = account
                  .data()
                  .locations.find((x) => x.id === document.location.loc);
              functions.logger.log("Found Location: ", location);
              const tz = location.address.tzId;
              const start = document.start_date.toMillis();
              const end = document.end_date.toMillis();
              const startQuery = generateQueryDateFirestore(start, tz);
              const endQuery = generateQueryDateFirestore(end, tz);
              const startMoment = moment.tz(start, tz).startOf("d");
              const endMoment = moment.tz(end, tz).startOf("d");
              const array = [];
              array.push(startQuery);
              while (startMoment.add(1, "days").diff(endMoment) < 0) {
                array.push(
                    generateQueryDateFirestore(
                        startMoment.clone().toDate().getTime(),
                        tz
                    )
                );
              }
              if (startQuery !== endQuery) {
                array.push(endQuery);
              }
              change.after.ref.update({query: array});
              functions.logger.log("Pushed Query Array: ", array);
            });
      } else {
        return 0;
      }
    });
function generateQueryDateFirestore(m, tz) {
  const initial = moment(m).tz(tz);
  const year = initial.format("YY");
  const month = +initial.format("MM") + 10;
  const day = +initial.format("DD") + 10;
  const formattedString = year + month.toString() + day.toString();
  return +formattedString;
}
function generateRandomId(l: number) {
  let result = "";
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const charactersLength = characters.length;
  for (let i = 0; i < l; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}
