/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */
import { render } from 'preact';
import { useState, useCallback, useEffect } from 'preact/hooks';
import { html } from 'htm/preact';
import { GoogleGenAI, Type } from '@google/genai';
import type { ComponentChild } from 'preact';

// Add a global declaration for the Google API client (gapi) and Google Identity Services (GIS)
declare global {
  interface Window {
    gapi: any;
    google: any;
  }
}

// --- Gemini AI Configuration ---
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- Google Sheets Configuration ---
const CLIENT_ID = '437469512207-hhpsi8cpvtsvddif5vjm65gci9g2d8t2.apps.googleusercontent.com'; // Provided by the user.
const DISCOVERY_DOCS = ["https://sheets.googleapis.com/$discovery/rest?version=v4"];
const SCOPES = "https://www.googleapis.com/auth/spreadsheets";

const TroubleshootingError = ({ error }) => {
    const [copyButtonText, setCopyButtonText] = useState('Copy');
    const origin = window.location.origin;

    const handleCopyOrigin = () => {
        navigator.clipboard.writeText(origin).then(() => {
            setCopyButtonText('Copied!');
            setTimeout(() => setCopyButtonText('Copy'), 2000);
        });
    };

    return html`
        <div class="troubleshooting-box">
            <p><strong>Sign-in failed.</strong> The authentication popup may have been blocked or there could be a configuration issue.</p>
            <p class="technical-details">Error details: <code>${error?.type || 'No type'} - ${error?.message || 'No message'}</code></p>
            <div class="troubleshooting-steps">
                <strong>Troubleshooting:</strong>
                <ol>
                    <li>Ensure popups from <code>accounts.google.com</code> are not blocked by your browser or extensions.</li>
                    <li>Add this app's URL to your Google Cloud project's "Authorized JavaScript origins".
                        <div class="origin-copy-container">
                            <code>${origin}</code>
                            <button onClick=${handleCopyOrigin}>${copyButtonText}</button>
                        </div>
                    </li>
                    <li>If your project is in "Testing" mode, ensure your Google account is added as a test user.</li>
                </ol>
            </div>
        </div>
    `;
};


const ProjectDetail = ({ task, onBack, spreadsheetId }) => {
    const [subTasks, setSubTasks] = useState([]);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState(null);
    const [isAdding, setIsAdding] = useState(false);

    // State for new sub-task inputs
    const [newSubTaskName, setNewSubTaskName] = useState('');
    const [newSubTaskAssignee, setNewSubTaskAssignee] = useState('');
    const [newSubTaskDueDate, setNewSubTaskDueDate] = useState('');

    // AI-powered sub-task generation state
    const [aiGoalInput, setAiGoalInput] = useState('');
    const [isGenerating, setIsGenerating] = useState(false);
    const [generationError, setGenerationError] = useState(null);
    const [suggestedSubTasks, setSuggestedSubTasks] = useState([]);
    const [selectedSubTasks, setSelectedSubTasks] = useState(new Set());


    const fetchSheetData = useCallback(async () => {
        setIsLoading(true);
        setError(null);
        try {
            const range = `'${task.name}'!A2:F100`;
            const response = await window.gapi.client.sheets.spreadsheets.values.get({
                spreadsheetId: spreadsheetId,
                range: range,
            });
            const values = response.result.values || [];
            const tasksWithIds = values.map((row, index) => ({
                id: index + 2, // Row number in the sheet
                status: row[2] || 'Todo',
                name: row[0] || '',
                assignee: row[1] || '',
                dueDate: row[4] || '',
            })).filter(t => t.name); // Filter out empty rows
            setSubTasks(tasksWithIds);
        } catch (err) {
            console.error('Error fetching sheet data:', err);
            if (err.result?.error?.code === 400 || err.result?.error?.message.includes('Unable to parse range')) {
                 setError(`Could not find a sheet named "${task.name}". Make sure a tab in your Google Sheet exactly matches the project name.`);
            } else {
                 setError('Could not load project details. Please check your connection and try again.');
            }
        } finally {
            setIsLoading(false);
        }
    }, [task.name, spreadsheetId]);

    useEffect(() => {
        fetchSheetData();
    }, [fetchSheetData]);

    const handleUpdateSheet = useCallback(async (rowId, column, value) => {
        try {
            const range = `'${task.name}'!${column}${rowId}`;
            await window.gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: range,
                valueInputOption: 'USER_ENTERED',
                resource: {
                    values: [[value]],
                },
            });
        } catch (err) {
            console.error('Failed to update sheet:', err);
            alert('Failed to save changes. Please try again.');
        }
    }, [task.name, spreadsheetId]);

    const handleAddNewSubTask = useCallback(async () => {
        if (!newSubTaskName.trim()) {
            alert('Please enter a task name.');
            return;
        }
        setIsAdding(true);
        try {
            const newRow = [[newSubTaskName, newSubTaskAssignee, 'Todo', '', newSubTaskDueDate]];
            await window.gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: `'${task.name}'!A:E`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: newRow,
                },
            });
            // Clear inputs and refresh data
            setNewSubTaskName('');
            setNewSubTaskAssignee('');
            setNewSubTaskDueDate('');
            await fetchSheetData();
        } catch (err) {
            console.error('Failed to add sub-task:', err);
            alert('Could not add the new sub-task. Please try again.');
        } finally {
            setIsAdding(false);
        }
    }, [task.name, newSubTaskName, newSubTaskAssignee, newSubTaskDueDate, fetchSheetData, spreadsheetId]);

    const handleGenerateSubTasks = useCallback(async () => {
        if (!aiGoalInput.trim() || isGenerating) return;

        setIsGenerating(true);
        setGenerationError(null);
        setSuggestedSubTasks([]);
        setSelectedSubTasks(new Set());

        const schema = {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    name: { type: Type.STRING, description: 'The specific, actionable sub-task name.' },
                    assignee: { type: Type.STRING, description: 'Suggest a relevant role or a placeholder name for the assignee.' },
                    dueDate: { type: Type.STRING, description: `A suggested due date in YYYY-MM-DD format. Today is ${new Date().toISOString().split('T')[0]}.` },
                },
                required: ['name'],
            },
        };

        try {
            const prompt = `You are a project management assistant for a production company called TrashTV. The current project is "${task.name}". Your task is to break down the following high-level goal into a list of smaller, actionable sub-tasks. For each sub-task, provide a name, a suggested assignee (e.g., "Editor", "Producer", "Sammy", "Jess"), and a suggested due date in YYYY-MM-DD format. Goal: "${aiGoalInput}"`;
            
            const response = await ai.models.generateContent({
                model: 'gemini-2.5-pro',
                contents: prompt,
                config: {
                    responseMimeType: 'application/json',
                    responseSchema: schema,
                },
            });

            const jsonString = response.text.trim();
            const generatedTasks = JSON.parse(jsonString);
            
            setSuggestedSubTasks(generatedTasks.map((t, index) => ({ ...t, id: `gen-${index}` })));
            const newSelected = new Set();
            generatedTasks.forEach((_, index) => newSelected.add(`gen-${index}`));
            setSelectedSubTasks(newSelected);

        } catch (err) {
            console.error('Error generating sub-tasks:', err);
            setGenerationError('Sorry, I couldn\'t generate sub-tasks for that. Please try rephrasing your goal.');
        } finally {
            setIsGenerating(false);
        }
    }, [aiGoalInput, isGenerating, task.name]);

    const handleToggleSuggestedTask = (taskId) => {
        const newSelection = new Set(selectedSubTasks);
        if (newSelection.has(taskId)) {
            newSelection.delete(taskId);
        } else {
            newSelection.add(taskId);
        }
        setSelectedSubTasks(newSelection);
    };

    const handleAddSelectedSubTasks = useCallback(async () => {
        const tasksToAdd = suggestedSubTasks.filter(t => selectedSubTasks.has(t.id));
        if (tasksToAdd.length === 0) return;

        setIsAdding(true);
        try {
            const newRows = tasksToAdd.map(t => [
                t.name || '',
                t.assignee || '',
                'Todo',
                '', // Notes
                t.dueDate || ''
            ]);
            
            await window.gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: `'${task.name}'!A:E`,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                resource: {
                    values: newRows,
                },
            });

            setAiGoalInput('');
            setSuggestedSubTasks([]);
            setSelectedSubTasks(new Set());
            await fetchSheetData();

        } catch (err) {
            console.error('Failed to add selected sub-tasks:', err);
            alert('Could not add the selected sub-tasks. Please try again.');
        } finally {
            setIsAdding(false);
        }
    }, [task.name, suggestedSubTasks, selectedSubTasks, fetchSheetData, spreadsheetId]);


    const handleStatusChange = (subTask, isChecked) => {
        const newStatus = isChecked ? 'Done' : 'In Progress';
        const updatedSubTasks = subTasks.map(st => 
            st.id === subTask.id ? { ...st, status: newStatus } : st
        );
        setSubTasks(updatedSubTasks);
        handleUpdateSheet(subTask.id, 'C', newStatus);
    };

    const handleNameChange = (subTask, newName) => {
         const updatedSubTasks = subTasks.map(st => 
            st.id === subTask.id ? { ...st, name: newName } : st
        );
        setSubTasks(updatedSubTasks);
        handleUpdateSheet(subTask.id, 'A', newName);
    }

    return html`
      <div class="project-detail-container">
        <button onClick=${onBack} class="back-button">← Back to Hub</button>
        <header>
          <h1>${task.name}</h1>
          <p>Editing live from Google Sheets</p>
        </header>

        ${isLoading && html`<div class="feedback loading">Loading project details...</div>`}
        ${error && html`<div class="feedback error">${error}</div>`}
        
        ${!isLoading && !error && html`
            <div class="ai-assistant-container">
                <h2>✨ AI Assistant</h2>
                <p>Describe a larger goal, and Gemini will break it down into sub-tasks for you.</p>
                <div class="ai-input-row">
                    <textarea 
                        placeholder="e.g., Plan and execute the promotional video shoot for the Chai x Pasty collab"
                        value=${aiGoalInput}
                        onInput=${e => setAiGoalInput(e.currentTarget.value)}
                        disabled=${isGenerating}
                        rows="3"
                    ></textarea>
                    <button onClick=${handleGenerateSubTasks} disabled=${isGenerating || !aiGoalInput.trim()}>
                        ${isGenerating ? 'Generating...' : 'Generate Tasks'}
                    </button>
                </div>
                ${generationError && html`<div class="feedback error small">${generationError}</div>`}
                ${isGenerating && !suggestedSubTasks.length && html`<div class="feedback loading small">Gemini is thinking...</div>`}

                ${suggestedSubTasks.length > 0 && html`
                    <div class="suggested-tasks-container">
                        <h3>Suggested Sub-tasks</h3>
                        <ul class="suggested-tasks-list">
                            ${suggestedSubTasks.map(st => html`
                                <li key=${st.id}>
                                    <label>
                                        <input 
                                            type="checkbox" 
                                            checked=${selectedSubTasks.has(st.id)}
                                            onChange=${() => handleToggleSuggestedTask(st.id)}
                                        />
                                        <div class="suggested-task-details">
                                            <span class="name">${st.name}</span>
                                            <span class="meta">
                                                ${st.assignee && `Assignee: ${st.assignee}`}
                                                ${st.assignee && st.dueDate && ' | '}
                                                ${st.dueDate && `Due: ${st.dueDate}`}
                                            </span>
                                        </div>
                                    </label>
                                </li>
                            `)}
                        </ul>
                        <button class="add-selected-button" onClick=${handleAddSelectedSubTasks} disabled=${isAdding || selectedSubTasks.size === 0}>
                            ${isAdding ? 'Adding...' : `＋ Add ${selectedSubTasks.size} Selected Tasks to Sheet`}
                        </button>
                    </div>
                `}
            </div>
            <div class="subtask-table-container">
                <table class="subtask-table">
                    <thead>
                        <tr>
                            <th class="col-status">Status</th>
                            <th class="col-task">Task</th>
                            <th class="col-assignee">Assignee</th>
                            <th class="col-due-date">Due Date</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${subTasks.map(st => html`
                            <tr key=${st.id} class=${st.status === 'Done' ? 'task-done' : ''}>
                                <td>
                                    <input 
                                        type="checkbox" 
                                        checked=${st.status === 'Done'}
                                        onChange=${(e) => handleStatusChange(st, e.currentTarget.checked)}
                                    />
                                </td>
                                <td>
                                    <input 
                                        type="text" 
                                        class="editable-text"
                                        defaultValue=${st.name} 
                                        onBlur=${(e) => e.currentTarget.value !== st.name && handleNameChange(st, e.currentTarget.value)}
                                    />
                                </td>
                                <td>${st.assignee}</td>
                                <td>${st.dueDate}</td>
                            </tr>
                        `)}
                    </tbody>
                    <tfoot>
                        <tr class="add-subtask-row">
                            <td></td>
                            <td>
                                <input 
                                    type="text" 
                                    class="editable-text"
                                    placeholder="Add new sub-task..."
                                    value=${newSubTaskName}
                                    onInput=${e => setNewSubTaskName(e.currentTarget.value)}
                                />
                            </td>
                            <td>
                                <input 
                                    type="text" 
                                    class="editable-text"
                                    placeholder="Assignee"
                                    value=${newSubTaskAssignee}
                                    onInput=${e => setNewSubTaskAssignee(e.currentTarget.value)}
                                />
                            </td>
                             <td>
                                <input 
                                    type="text" 
                                    class="editable-text"
                                    placeholder="Due Date"
                                    value=${newSubTaskDueDate}
                                    onInput=${e => setNewSubTaskDueDate(e.currentTarget.value)}
                                />
                            </td>
                        </tr>
                        <tr>
                            <td colspan="4">
                                <button class="add-subtask-button" onClick=${handleAddNewSubTask} disabled=${isAdding}>
                                    ${isAdding ? 'Adding...' : '＋ Add Sub-task'}
                                </button>
                            </td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        `}
      </div>
    `;
};

const Setup = ({ onSave }) => {
  const [inputId, setInputId] = useState('');

  const handleSave = () => {
    if (inputId.trim()) {
      onSave(inputId.trim());
    } else {
      alert('Please enter a valid Spreadsheet ID.');
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSave();
    }
  };

  return html`
    <div class="setup-container">
        <h1>Welcome to the Production Hub</h1>
        <p>To get started, please connect to your Google Spreadsheet.</p>
        <p class="setup-instructions">You can find the ID in the URL of your spreadsheet: <br/> <code>https://docs.google.com/spreadsheets/d/</code><strong><code>SPREADSHEET_ID</code></strong><code>/edit</code></p>
        <input 
          type="text" 
          value=${inputId} 
          onInput=${e => setInputId(e.currentTarget.value)}
          onKeyPress=${handleKeyPress}
          placeholder="Enter Spreadsheet ID"
          aria-label="Google Spreadsheet ID"
        />
        <button onClick=${handleSave}>Save and Continue</button>
    </div>
  `;
};


const App = () => {
  const [tasks, setTasks] = useState([
    { name: 'Chai x Pasty GRWM', priority: 'High Priority', assignee: 'Taylor Trash', status: 'In Progress', startDate: '2025-10-20', dueDate: '2025-10-24', notes: 'Need to add in viewing party footage, needs SH review & sign off' },
    { name: 'Taylor RPDR Audition Tape', priority: 'High Priority', assignee: 'Taylor Trash', status: 'In Progress', startDate: '2025-10-20', dueDate: '2025-10-27', notes: 'TT to do' },
    { name: 'TrashTV Logo Design', priority: 'High Priority', assignee: 'Taylor Trash', status: 'In Progress', startDate: null, dueDate: '2025-10-24', notes: 'SH - TT review' },
    { name: 'Follow up with National Lottery Grant', priority: 'High Priority', assignee: 'Taylor Trash', status: 'In Progress', startDate: null, dueDate: null, notes: 'TT to do' },
    { name: 'Follow up with ITV Grant', priority: 'High Priority', assignee: 'Taylor Trash', status: 'Todo', startDate: null, dueDate: null, notes: 'TT to do - needs SH support' },
    { name: 'Access to Work Headphones for Jess', priority: 'High Priority', assignee: 'Taylor Trash', status: 'Todo', startDate: null, dueDate: null, notes: 'TT to do - needs SH support' },
    { name: 'Pasty Oversize Photoshoot', priority: 'Low Priority', assignee: 'sammy@trashtv.productions', status: 'Todo', startDate: '2025-10-24', dueDate: '2025-10-24', notes: 'SH waiting to hear back from Mikis' },
    { name: 'The Gold Rush Pitch Sizzle Reel', priority: 'Low Priority', assignee: 'sammy@trashtv.productions', status: 'In Progress', startDate: null, dueDate: '2025-11-28', notes: 'Ongoing' },
    { name: 'Pasty Dragumentary', priority: 'Low Priority', assignee: 'jess@trashtv.productions', status: 'Todo', startDate: null, dueDate: '2025-11-27', notes: null },
    { name: 'Sweet Tea x Jan podcast content', priority: 'Low Priority', assignee: 'jess@trashtv.productions', status: 'Todo', startDate: null, dueDate: '2025-11-27', notes: null },
    { name: 'DragCon 2025 Interviews', priority: 'Low Priority', assignee: 'sammy@trashtv.productions', status: 'In Progress', startDate: null, dueDate: '2026-01-10', notes: null },
    { name: 'Sweet Tea x Michael Marouli YT content', priority: 'Low Priority', assignee: 'jess@trashtv.productions', status: 'Todo', startDate: null, dueDate: null, notes: null },
    { name: 'Sweet Tea x Bobby Summers YT content', priority: 'Low Priority', assignee: 'sammy@trashtv.productions', status: 'In Progress', startDate: null, dueDate: null, notes: null },
    { name: 'Sweet Tea x Lawrence Chaney YT content', priority: 'Low Priority', assignee: 'jess@trashtv.productions', status: 'Todo', startDate: null, dueDate: null, notes: null },
    { name: 'Follow up on FSB Grant', priority: 'Low Priority', assignee: 'Taylor Trash', status: 'Todo', startDate: null, dueDate: null, notes: null },
    { name: 'Follow up with BFi Grant', priority: 'Low Priority', assignee: 'Taylor Trash', status: 'Todo', startDate: null, dueDate: null, notes: null },
    { name: 'Chai x Pasty \'Hot Ones\'', priority: 'Mid-level Priority', assignee: 'jess@trashtv.productions', status: 'Todo', startDate: null, dueDate: '2025-10-27', notes: null },
    { name: 'Anita Piss Trashy Takeover video', priority: 'Mid-level Priority', assignee: 'sammy@trashtv.productions', status: 'In Progress', startDate: null, dueDate: null, notes: null },
    { name: 'Follow up with Tottenham Grant', priority: 'Mid-level Priority', assignee: 'Taylor Trash', status: 'Todo', startDate: null, dueDate: null, notes: null }
  ]);
  const [newTaskInput, setNewTaskInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<ComponentChild>(null);
  const [activeTab, setActiveTab] = useState('jobs');
  const [selectedTask, setSelectedTask] = useState(null);
  const [activeFilter, setActiveFilter] = useState('all');

  const [gapiReady, setGapiReady] = useState(false);
  const [isSignedIn, setIsSignedIn] = useState(false);
  const [spreadsheetId, setSpreadsheetId] = useState(null);
  const [tokenClient, setTokenClient] = useState(null);

  useEffect(() => {
    const savedId = localStorage.getItem('spreadsheetId');
    if (savedId) {
        setSpreadsheetId(savedId);
    }
  }, []);

  useEffect(() => {
    const initializeApis = async () => {
        try {
            // Load GAPI for Sheets API client
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://apis.google.com/js/api.js';
                script.async = true;
                script.defer = true;
                script.onload = resolve;
                script.onerror = reject;
                document.body.appendChild(script);
            });
            await new Promise((resolve) => window.gapi.load('client', resolve));
            await window.gapi.client.init({ discoveryDocs: DISCOVERY_DOCS });

            // Load Google Identity Services (GIS) for Authentication
            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://accounts.google.com/gsi/client';
                script.async = true;
                script.defer = true;
                script.onload = resolve;
                script.onerror = reject;
                document.body.appendChild(script);
            });

            // Create and configure the token client
            const client = window.google.accounts.oauth2.initTokenClient({
                client_id: CLIENT_ID,
                scope: SCOPES,
                callback: (tokenResponse) => {
                    if (tokenResponse && tokenResponse.access_token) {
                        window.gapi.client.setToken(tokenResponse);
                        setIsSignedIn(true);
                    } else {
                        console.error('Authentication failed: Invalid token response.', tokenResponse);
                        setError('Authentication failed. Please try again.');
                    }
                },
                error_callback: (error) => {
                     console.error("Google Sign-In Error:", error);

                     const errorType = typeof error === 'string'
                         ? error
                         : error?.type || error?.error || '';
                     const errorMessageText = (typeof error === 'string'
                         ? error
                         : error?.message || '')
                         .toLowerCase();

                     // This is a common user action, not a technical failure.
                     if (
                         errorType === 'popup_closed_by_user' ||
                         errorType === 'popup_closed' ||
                         errorMessageText.includes('popup window closed') ||
                         errorMessageText.includes('popup closed') ||
                         errorMessageText.includes('window closed')
                     ) {
                         // Clear any previous troubleshooting message and keep the UI ready for another attempt.
                         setError(null);
                         return;
                     }

                     // For other errors, provide detailed troubleshooting.
                     const errorMessage = html`<${TroubleshootingError} error=${error} />`;
                     setError(errorMessage);
                }
            });
            setTokenClient(client);
            setGapiReady(true);
        } catch (err) {
            console.error("API Initialization Error", err);
            setError("Could not load Google services. Check your internet connection or browser extensions (e.g., ad-blockers).");
            setGapiReady(true);
        }
    };

    initializeApis();
  }, []);

  const handleAuthClick = () => {
    setError(null); // Clear previous errors on a new attempt
    if (tokenClient) {
      // Prompt the user to select an account and grant access.
      tokenClient.requestAccessToken();
    } else {
      setError("Google Sign-In is not ready yet. Please wait a moment.");
    }
  };
  
  const handleSaveSpreadsheetId = (id) => {
    localStorage.setItem('spreadsheetId', id);
    setSpreadsheetId(id);
  };

  const handleChangeSpreadsheet = () => {
      localStorage.removeItem('spreadsheetId');
      setSpreadsheetId(null);
  };

  const filters = {
    'All': 'all',
    'Taylor Trash': 'Taylor Trash',
    'Jess Queen': 'jess@trashtv.productions',
    'Sammy Harkin': 'sammy@trashtv.productions',
  };

  const handleAddTask = useCallback(async (e) => {
    e.preventDefault();
    if (!newTaskInput.trim() || isLoading) return;

    setIsLoading(true);
    setError(null);

    const schema = {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING, description: 'The name or title of the task.' },
        assignee: { type: Type.STRING, description: 'The full name or email of the person assigned to the task.' },
        dueDate: { type: Type.STRING, description: 'The due date of the task in YYYY-MM-DD format.' },
        priority: { type: Type.STRING, enum: ['High Priority', 'Mid-level Priority', 'Low Priority'], description: 'The priority of the task. Defaults to Low Priority if not specified.' },
        notes: { type: Type.STRING, description: 'Any notes or additional details about the task.'}
      },
      required: ['name', 'assignee', 'dueDate', 'priority'],
    };

    try {
      const prompt = `You are a project management assistant for a production company. Parse the following task request and extract the task name, the person it's assigned to, the due date, priority, and any notes. Today's date is ${new Date().toISOString().split('T')[0]}. If a year is not specified for a date, assume the current year or next year if the date has passed. Return the result in a JSON object that strictly adheres to the provided schema. Request: "${newTaskInput}"`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-pro',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema,
        },
      });

      const jsonString = response.text.trim();
      const newTaskData = JSON.parse(jsonString);

      if (newTaskData.name && newTaskData.assignee && newTaskData.dueDate) {
          setTasks(prevTasks => [...prevTasks, { ...newTaskData, status: 'Todo', startDate: null }]);
          setNewTaskInput('');
      } else {
          throw new Error("Invalid task data received from AI.");
      }

    } catch (err) {
      console.error(err);
      setError('Sorry, I couldn\'t understand that. Please try rephrasing your request.');
    } finally {
      setIsLoading(false);
    }
  }, [newTaskInput, isLoading]);

  const handleTaskClick = useCallback((task) => {
    setSelectedTask(task);
  }, []);

  const handleBackClick = useCallback(() => {
    setSelectedTask(null);
  }, []);

  if (!gapiReady) {
    return html`<div class="container feedback loading">Initializing...</div>`;
  }
  
  if (!isSignedIn) {
      return html`
        <div class="container">
           <div class="signin-container">
                <h1>TrashTV Production Hub</h1>
                <p>Please sign in with your Google account to access project details and edit live spreadsheets.</p>
                ${error && html`<div class="feedback error" style=${{marginBottom: '1rem', textAlign: 'left'}}>${error}</div>`}
                <button onClick=${handleAuthClick} class="signin-button" disabled=${!tokenClient}>
                    <svg width="18" height="18" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 488 512"><path fill="currentColor" d="M488 261.8C488 403.3 381.5 512 244 512 109.8 512 0 402.2 0 261.8 0 120.5 109.8 8.4 244 8.4c69.1 0 125.3 27.8 168.7 72.2l-67.7 66.8C314.6 114.6 282.4 96.3 244 96.3c-83.2 0-151.2 67.2-151.2 150.1s68 150.1 151.2 150.1c96.3 0 130.2-70.1 135-108.3H244v-85.3h236.1c2.3 12.7 3.9 26.9 3.9 41.4z"></path></svg>
                    Sign in with Google
                </button>
            </div>
        </div>
      `;
  }

  if (!spreadsheetId) {
    return html`<div class="container"><${Setup} onSave=${handleSaveSpreadsheetId} /></div>`;
  }

  if (selectedTask) {
    return html`<${ProjectDetail} task=${selectedTask} onBack=${handleBackClick} spreadsheetId=${spreadsheetId} />`;
  }

  return html`
    <div class="container">
      <header>
        <h1>TrashTV Production Hub</h1>
        <p>Your intelligent project dashboard, powered by Gemini.</p>
        <button onClick=${handleChangeSpreadsheet} class="change-spreadsheet-btn">Change Spreadsheet</button>
      </header>
      
      <form class="task-input-form" onSubmit=${handleAddTask}>
        <input 
          type="text" 
          value=${newTaskInput} 
          onInput=${e => setNewTaskInput(e.currentTarget.value)}
          placeholder="e.g., Edit sizzle reel for Jess, due next Friday"
          aria-label="New task input"
          disabled=${isLoading}
        />
        <button type="submit" disabled=${isLoading}>
          ${isLoading ? 'Adding...' : 'Add Task'}
        </button>
      </form>

      ${error && html`<div class="feedback error">${error}</div>`}

      <div class="tabs" role="tablist" aria-label="Production Hub sections">
        <button 
          class="tab-button ${activeTab === 'jobs' ? 'active' : ''}" 
          onClick=${() => setActiveTab('jobs')}
          role="tab"
          aria-selected=${activeTab === 'jobs'}
        >
          Live Jobs
        </button>
        <button 
          class="tab-button ${activeTab === 'calendar' ? 'active' : ''}" 
          onClick=${() => setActiveTab('calendar')}
          role="tab"
          aria-selected=${activeTab === 'calendar'}
        >
          Werk Calendar
        </button>
      </div>

      <div class="tab-content">
        ${activeTab === 'jobs' && html`
          <div class="task-list-container" role="tabpanel">
            <div class="filter-container">
              ${Object.keys(filters).map(filterName => html`
                <button
                  class="filter-button ${activeFilter === filters[filterName] ? 'active' : ''}"
                  onClick=${() => setActiveFilter(filters[filterName])}
                >
                  ${filterName}
                </button>
              `)}
            </div>
            ${isLoading && tasks.length === 0 && html`<div class="feedback loading">Loading tasks...</div>`}
            <ul class="task-list">
              ${tasks.filter(task => activeFilter === 'all' || task.assignee === activeFilter)
                .sort((a, b) => {
                  const dateA = a.dueDate ? new Date(a.dueDate + 'T00:00:00').getTime() : Infinity;
                  const dateB = b.dueDate ? new Date(b.dueDate + 'T00:00:00').getTime() : Infinity;
                  return dateA - dateB;
                })
                .map(task => html`
                  <li class="task-item priority-${task.priority.replace(/\s+/g, '-').toLowerCase()}" key=${task.name + task.dueDate} onClick=${() => handleTaskClick(task)} role="button" tabindex="0" aria-label="View details for ${task.name}">
                    <div class="task-item-details">
                      <span class="name">${task.name}</span>
                      <span class="assignee">Assigned to: ${task.assignee}</span>
                    </div>
                    <div class="task-item-meta">
                      <span class="status-indicator status-${task.status.replace(/\s+/g, '-').toLowerCase()}">${task.status}</span>
                      ${task.dueDate && html`<span class="due-date">${new Date(task.dueDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</span>`}
                    </div>
                  </li>
                `)}
            </ul>
          </div>
        `}
        ${activeTab === 'calendar' && html`
          <div class="calendar-container" role="tabpanel">
            <iframe 
              src="https://calendar.google.com/calendar/embed?src=family10870860777471349340%4@group.calendar.google.com&ctz=Europe%2FLondon"
              class="calendar-iframe"
              frameBorder="0"
              scrolling="no"
              title="Production Calendar"
            ></iframe>
          </div>
        `}
      </div>
    </div>
  `;
};

render(html`<${App} />`, document.getElementById('app'));