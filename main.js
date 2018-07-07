const electron = require('electron');
const url = require('url');
const path = require('path');
const fs = require('fs');

const { app, BrowserWindow, Menu, ipcMain, dialog } = electron;

// Set ENV
process.env.NODE_ENV = 'production';

let mainWindow;
let infoWindow;

// App ready
app.on('ready', function () {
    // Create window
    mainWindow = new BrowserWindow({
        minHeight:770,
        minWidth:1240,
        width:1240,
        height:790,
        title:"Squish velocity calculator"
    });

    // Load HTML to the window
    mainWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'mainWindow.html'),
        protocol: 'file:',
        slashes: true
    }));

    // Add menu
    const mainMenu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(mainMenu);
});


Math.radians = function (degrees) {
    return degrees * Math.PI / 180;
};

Math.degrees = function (radians) {
    return radians * 180 / Math.PI;
};

function calculateSquishInfo(data) {
    //data = bore, stroke, conrod, rpm, exhtiming, compratio, sqarearatio, sqangle, sqclear
    const boreMeters = data[0] / 1000; // input is in mm, so /1000 gives meters
    const strokeMeters = data[1] / 1000; // input is in mm, so /1000 gives meters
    const conrodMeters = data[2] / 1000; // input is in mm, so /1000 gives meters
    const RPM = data[3];
    const exhTiming = data[4]; // in degrees after tdc
    const compratio = data[5];
    const squish_area_ratio = data[6] / 100; // ratio of areas, NOT diameters/radii (% -> ratio)
    const squish_angle = data[7]; // in degrees
    const squish_clearance = data[8] / 1000; // input is in mm, so /1000 gives meters

    // calculate further info from the input
    const piston_area = Math.PI * (boreMeters ** 2) / 4; // piston top face area in m^2
    const swept_vol = piston_area * strokeMeters; // cylinder swept volume in m^3


    // crank angle in degrees, return piston position in meters
    function pistonPosition(crank_angle) {
        ct = strokeMeters / 2;
        alpha = Math.degrees(Math.asin(ct * Math.sin(Math.radians(crank_angle)) / conrodMeters))
        x = conrodMeters + ct - Math.cos(Math.radians(alpha)) * conrodMeters - Math.cos(Math.radians(crank_angle)) * ct;
        return x;
    }

    exh_opens_a = pistonPosition(exhTiming);
    trapped_swept_vol = piston_area * exh_opens_a;
    clearance_vol = trapped_swept_vol / (compratio - 1)
    squish_area = squish_area_ratio * piston_area; // area perpendicular to piston face, independent of squish angle
    bowl_area = piston_area - squish_area; // the rest of piston face area in the head is the bowl
    bowl_diam = Math.sqrt(4 * bowl_area / Math.PI);

    squish_radial_radius = (boreMeters - bowl_diam) / 2; // Inner radius of squish band measured perpendicular to piston face
    squish_cone_height = Math.tan(Math.radians(squish_angle)) * squish_radial_radius;
    squish_cone_vol = 1 / 3 * Math.PI * Math.pow(squish_radial_radius, 2) * squish_cone_height; // approximating the squish band is a perfect cone
    squish_bowl_vol = squish_clearance * bowl_area; // volume in the bowl area at the height of sq clearance above piston

    squish_vol = squish_clearance * squish_area; // band volume, symmetry of a ring (cone vol caused by squish angle not included)
    if (squish_angle > 0) {
        squish_vol += squish_cone_vol; // add the cone volume if a cone is present (sq angle > 0)
    }

    bowl_vol = clearance_vol - squish_vol - squish_bowl_vol; // the rest of the volume is the "bowl" of the head

    // Setting the initial conditions for the calculation:
    pressure_trap = 101325; // using ambient 20 C air as reference (to be altered in future versions?)
    temp_trap = 293.15; // using ambient 20 C air as reference
    R = 287.058 // gas constant
    G = 1.401 // Gamma constant
    step = 0.1; // Size of one time step in deg

    vol_sq_a = exh_opens_a * squish_area + squish_vol; // starting sq vol = hollow cylinder of height exh_opens_a with squish area + squish vol itself
    vol_bowl_a = exh_opens_a * bowl_area + bowl_vol + squish_bowl_vol; // starting bowl vol = cylinder of height exh_opens_a with bowl area + squish bowl vol itself
    vol_cyl_a = exh_opens_a * piston_area + clearance_vol; // starting cyl vol = cylinder of height exh_opens_a with piston area + clearance volume
    vol_trap = vol_cyl_a; // trapped volume is the cylinder volume at which exh port closes

    mass_trap = pressure_trap * vol_trap / (R * temp_trap);

    // Initially every component of the system is at the same equal pressure (p_trap / p_cyl_a in this case)
    p_cyl_a = pressure_trap;
    p_sq_a = p_cyl_a;
    p_bowl_a = p_cyl_a;

    mass_sq_a = mass_trap * vol_sq_a / vol_cyl_a;
    dt = step / (6 * RPM) // delta t

    angleDown = (360 - exhTiming)

    sq_v_array = [];
    crank_angle_array = [];
    energy_array = [];
    max_sq_v = 0;
    max_crank_angle = 0;
    p_max = 0;

    while (angleDown <= 360) {
        exh_opens_b = pistonPosition(angleDown);
        dh = exh_opens_a - exh_opens_b; // delta h

        // New values
        vol_sq_b = exh_opens_b * squish_area + squish_vol;
        vol_bowl_b = exh_opens_b * bowl_area + squish_bowl_vol + bowl_vol;
        vol_cyl_b = exh_opens_b * piston_area + clearance_vol;

        p_cyl_b = pressure_trap * Math.pow((pressure_trap / vol_cyl_b), G);
        temp_cyl_b = p_cyl_b * vol_cyl_b / (mass_trap * R);
        rho_cyl_b = p_cyl_b / (R * temp_cyl_b);

        p_sq_b = p_sq_a * Math.pow((vol_sq_a / vol_sq_b), G);
        p_bowl_b = p_bowl_a * Math.pow((vol_bowl_a / vol_bowl_b), G);

        mass_sq_b = mass_trap * vol_sq_b / vol_cyl_b;

        dmsq = mass_sq_a - mass_sq_b; // delta mass_squish
        sq_height = exh_opens_a + squish_clearance - 0.5 * dh + squish_cone_height;
        sq_v_circle = Math.PI * bowl_diam; // ring with radius of the bowl radius ("ID of the squishband")
        sq_v_area = sq_height * sq_v_circle;
        sq_v = dmsq / (rho_cyl_b * sq_v_area * dt);

        sq_v_array.push(sq_v);
        crank_angle_array.push(360 - angleDown);
        if (sq_v > max_sq_v) {
            max_sq_v = sq_v;
            max_crank_angle = 360 - angleDown;
        }

        p_ratio = p_sq_b / p_bowl_b;
        if (p_ratio > p_max) p_max = p_ratio;

        k_e = 0.5 * dmsq * Math.pow(sq_v, 2); // KE = 1/2 * m * v^2 (kinetic energy)
        energy_array.push(k_e * 1000);

        exh_opens_a = exh_opens_b;
        vol_sq_a = vol_sq_b;
        mass_sq_a = mass_sq_b;
        p_sq_a = p_sq_b;
        p_bowl_a = p_bowl_b;

        angleDown += step;

    }

    dataArray = [max_sq_v, max_crank_angle, sq_v_array, crank_angle_array, p_max, energy_array];
    mainWindow.webContents.send('calculatedData', dataArray);
}

// Catch form data
ipcMain.on('formData', function (e, data) {
    calculateSquishInfo(data);
});

// Can't save, notify the user
ipcMain.on('cantSave', function (e) {
    dialog.showMessageBox(mainWindow, {
        type:'error',
        title:'Error saving',
        message:'Error saving the data. Check for warnings in the main window!'
    });
});

// Catch form data to be saved
ipcMain.on('saveData', function (e, data) {
    saveData(data, e);
});

ipcMain.on('openData', function(e) {
    readDataFile();
})

function saveData(data, e) {
    dialog.showSaveDialog(mainWindow, {
        title: 'Save engine data',
        defaultPath: '~/SQV_Calc_engine_data.dat'
    }, function (filename) {
        saveFile(filename, data);
    });
}

function readData(filename) {
    try {
        fs.readFile(filename[0], function(err, data) {
            var dataArray = data.toString().split(",");
            mainWindow.webContents.send('dataIncoming', dataArray);
        });
    }
    catch (e) {
    }
}

function readDataFile() {
    dialog.showOpenDialog(mainWindow, {
        title:'Open engine data',
        properties:['openFile']
    }, function(filename) {
        readData(filename);
    });
}

function saveFile(filename, data) {
    try {
        fs.writeFileSync(filename, data, 'utf-8');
    }
    catch (e) {
    }
}

function showInfo() {
    infoWindow = new BrowserWindow({
        width:590,
        height:250,
        title:'About the program',
        resizable:false
    });

    infoWindow.loadURL(url.format({
        pathname: path.join(__dirname, 'info.html'),
        protocol:'file:',
        slashes:true
    }));
}

const menuTemplate = [
    {
        label: 'File',
        submenu: [
            {
                label: 'Open engine data',
                accelerator: 'CmdOrCtrl+O',
                click() {
                    readDataFile();
                }
            },
            {
                label: 'Save engine data',
                accelerator: 'CmdOrCtrl+S',
                click() {
                    mainWindow.webContents.send('wantToSave');
                }
            },
            {
                label: 'Quit',
                accelerator: 'CmdOrCtrl+Q',
                click() {
                    app.quit();
                }
            }
        ]
    },
    {
        label: 'Info',
        submenu: [
            {
                label: 'About',
                click() {
                    showInfo();
                }
            }
        ]
    }
]

if (process.env.NODE_ENV !== 'production') {
    menuTemplate.push({
        label: 'Developer tools',
        submenu: [{
            label: 'Toggle',
            accelerator: 'CmdOrCtrl+I',
            click(item, focusedWindow) {
                focusedWindow.toggleDevTools();
            }
        },
        {
            role: 'reload'
        }]
    });
}