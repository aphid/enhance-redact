//some includes
import * as fs from 'fs';
import * as cp from 'child_process';
import ollama from 'ollama';
import SSH2Promise from 'ssh2-promise';
import SFTP from 'ssh2-promise/lib/sftp.js'
import Rsync from "@moritzloewenstein/rsync";
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
  new Agent({
    headersTimeout: 1200000,
    connectTimeout: 1200000,
    bodyTimeout: 1200000,
  }),
);


let auth = JSON.parse(fs.readFileSync("auth.json"));

let dirs = ["sources/", "images/", "sounds/", "text/", "data/", "logrtty/"];

let sshconfig = { 
	host: 'slowscan.local', 
	username: 'aphid', 
	identity: '/home/aphid/.ssh/id_ed25519',
	reconnectTries: 10,
	reconnectDelay: 5000
};

const here = "/home/aphid/projects/enhanceRedact/";

let ssh = new SSH2Promise(sshconfig);


const CTdir = "./sources/";

//source img + _process_gen.
const imgDir = "./images/";
const wavDir = "./sounds/";
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function log(event, object){
  let now = new Date();
  let logItem = { event: event, date: now.toISOString(),  epoch: now.getTime(), object };
  let log = JSON.parse(fs.readFileSync("log.json"));
  log.push(logItem);
  fs.writeFileSync("log.json", JSON.stringify(log, undefined, 2));
}

async function changeTitle(title,tries){
    if (tries && tries > 8) {
       log("failed title", { title: title });
       return false;
    }
    if (!tries){
       tries = 0;
    }
    title = encodeURIComponent(title);
    let cmd = `curl -u admin:${auth.icepass} "https://station.aphid.org:8443/admin/metadata?mode=updinfo&mount=/enhance-redact.mp3&song=${title}"`;
    console.log(cmd);
    try { 
        let asdf = cp.execSync(cmd);
	if (asdf.toString().includes(" successful")){
           console.log("TITLE UPDATED");
	   return Promise.resolve();
	}

    } catch(e){
      //todo retry
      tries++;
      return changeTitle(title,tries);
	    
    }
}


function base64_encode(file) {
  // read binary data
  var bitmap = fs.readFileSync(file);
  // convert binary data to base64 encoded string
  return Buffer.from(bitmap).toString('base64');
}


async function sync(filter){
   let drs = dirs;
   if (filter){
     drs = [filter];
   }
   console.log(drs);
   console.log("syncing rtty->sstv");
   for (let d of drs){

    const rsync = new Rsync({
       source: `${d}`,
       destination: `slowscan.local:~/${d}`,
       flags: "avz",
       shell: "ssh",
    });

   try {
      const result = await rsync.execute((data) => { 
	      console.log(data.toString())
	      }, (data) => { 
		 //console.error(data.toString())
      });
      //console.log("Transfer complete:", result.cmd);
   } catch (error) {
      console.error("Transfer failed:", error);
   }
   console.log("sync complete");
}
   console.log("syncing sstv->rtty"); 
   for (let d of drs){

   const rsync = new Rsync({
      source: `slowscan.local:~/${d}`,
      destination: `${d}`,
      flags: "avz",
      progress: true,
      shell: "ssh",
   });
   
   try {
      const result = await rsync.execute((data) => { 
	      //console.log(data.toString()); 
	      }, (data) => { 
	      //console.error(data.toString())
     });
      //console.log("Transfer complete:", result.cmd);
   } catch (error) {
      console.error("Transfer failed:", error);
   }
   console.log("sync complete");

}
console.log("syncs complete");
return Promise.resolve();

}

let spawnProm = async function (cmd, args, options, passed) {

    //let cmd = `/home/aphid/fm_transmitter/fm_transmitter`;
    //let args = [`-f`, `${freq}`, `/home/aphid/scrambler/stereo.wav`];
    if (!options) {
        options = {};
    }

    console.log(options)

    return new Promise(async (resolve, reject) => {
        try {


            let child = cp.spawn(cmd, [...args], options);
            if (passed) {
                console.log(passed);
                child.stdin.write(passed);
                child.stdin.end();
            }

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            let outout = "";
            child.stdout.on('data', function (data) {
                //Here is where the output goes
                data = data.toString();
                outout += data.replace("\n", "");
            });
            child.stderr.on('data', (data) => {
		if (options === "enhance"){
                   //parse data here, rtty-text progress per some interval
		}
                console.log(data.toString());
            });
            child.on('close', async (code) => {
                resolve(outout);
            });
            child.on('error', async (e) => {
                console.log("uhoh");
                console.log(e);
                throw ("oof");
                reject(e);
            });
            child.on('exit', async (code) => {
                resolve(outout);
            });
        } catch (e) {
            console.error(e);
	    throw(e);
        }
    });

}


//cycle goes (raw or existing) -> shrink/sstv -> transmit -> receive -> decode -> enhance -> visionModel (blocking: --> rtty --> queue/transmit) --> differenceCheck (no more than 70% different?; bell?) repeat;

//need to pass a file and normalize a dir.
let xmit = async function(fn){
    console.log("xmitting " + fn);
    try { 
        let asdf = await ssh.exec(`sudo killall fm_transmitter`);
	console.log(asdf);
    } catch(e) {
        console.log(e);
    }
    await ssh.connect();
    await sleep(250);
    let cmd = `sudo ./fm_transmitter/fm_transmitter -f 91.30 ${fn}`;
    let command = await ssh.exec(cmd);
    console.log('remote running', cmd,  command);
    if (command.includes("does not exist")){
        log("missing file: " + fn);
    }
    await sleep(250);
    ssh.removeAllListeners();
    ssh.close();
    return Promise.resolve();
}

let logRTTY = async function(text){
    await sleep(5000);
    console.log(`Logging ${text}`);
    let fn = Date.now(); 
    let wav = "logrtty/" + fn + ".wav";
    let txt = "logrtty/" + fn + ".txt";
    await rttyEncode(text, wav);
    fs.writeFileSync(txt, text);
    await sync("logrtty/");
    await sync("sounds/");
    console.log(text);
    updateStatus({status: "logging", message: text, description: "a lo-fidelity high pitched square wave trill, jumping rapidly back and forth between 1400 and 1800Hz for a duration that corresponds to the length of the encoded text. It is likely a digital frequency-shift keying transmission with audio-rate variations.", descriptionAuthor: "Ezra Teboul"});
    await xmit(wav);
    await sleep(12000);
    return Promise.resolve();

}

//it would be nice to have these as objects so that mfg metadata gets passed with specific transcript
//
let breaths = JSON.parse(fs.readFileSync("breaths.json"));


let inhale = async function (){
    let i = getRandomInt(0, breaths.length - 1);
    let breath = breaths[i];
    let bf = "breaths/" + breath.inhale;
    updateStatus({ status: "recognizing", description: `'${breath.inhaleWords}' spoken by a computerized female voice`, source: "recording of a CT scan breath instruction", manufacturer: breath.manufacturer, cycleDuration: (Date.now() - breathTimer) / 1000});
    console.log("breathe in and hold it");
    await xmit(bf);
    return Promise.resolve(i);
}

let exhale = async function (i){
    let breath =  breaths[i];
    let bf = "breaths/" + breath.exhale;
    updateStatus({ status: "recognizing", description: `'${breath.exhaleWords}' spoken by a computerized female voice`, source: "recording of a CT scan breath instruction", manufacturer: breath.manufacturer, cycleDuration: (Date.now() - breathTimer) / 1000});
    console.log("you may breathe normally");
    await xmit(bf);
    return Promise.resolve ();
}

let radbell = async function(){
    updateStatus({ status: "marking time", description: "a hand bell rings several times, celebrating the end of radiation treatment" });
    console.log("ding ding ding");
    await xmit("radbell.wav");
    await sleep(3000);
    return Promise.resolve();
}

let beachbell = async function(){
    updateStatus({ status: "marking time", description: "a hand bell is rung several times, celebrating the end of radiation treatment"});
    console.log("DING DING DING");
    await xmit("a_bell.wav");
    await xmit("d_bell.wav");
    await sleep(23000);
    return Promise.resolve();
}

let breathing = false;

let breathCycle = async function (img){
    console.log("breathing?", breathing);
    await sleep(25000);
    if (!breathing){
	return Promise.resolve();
    }
    console.log("processing", img);
    let i = await inhale();
    await sleep(7500);
    await exhale(i);
    return await breathCycle(img);
}

function getRandomInt(min, max) {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
}


let enhance = async function(inn,out){
    updateStatus({ status: "enhancing" });
    console.log("Running enhance on", inn, "to", out);
    return new Promise(async(resolve, reject) => {
    console.log(new Date());
    console.log("spawning...");
    let lastNum = 0;
    await ssh.connect();
    let command = await ssh.spawn(`Real-ESRGAN-ncnn-vulkan/realesrgan-ncnn-vulkan -i ${inn} -o ${out}`); //-n realesrgan-x4plus? currently fails with 'killed' 
    command.stderr.on('data', (data) => {
       let dataString = data.toString();
       console.log(dataString);
       let pct = parseInt(dataString);
       if (pct % 5 == 0 && pct > lastNum){
          logRTTY(dataString);
	  lastNum = pct;
       }
    });
    command.on('exit', () => {
    console.log(new Date());
    ssh.removeAllListeners();
    ssh.close();
    resolve();
    });
    command.on('close', () => {
    console.log(new Date());
    ssh.removeAllListeners();	    
    ssh.close();
    resolve();
    });
    command.on('error', (e) => {
       console.log(e);
	    ssh.removeAllListeners();
	    ssh.close();
	    reject(e);
    });
    });

}



//inputs img, returns wav path
let sstvEncode = async function (img, options) {
    let output = img.replace(".png", ".wav");
    output = output.replace("images/", "sounds/");
    console.log(`converting ${img} to ${output}`);
    let cmd = "python";
    let args = ["-m", "pysstv", "--rate", "44100", "--mode", "PD290", here + img, here + output];
    console.log(cmd, args);
    let sp = await spawnProm(cmd, args, { cwd: "/home/aphid/apps/pySSTV/" });

    //is image right size? 800x616
    //command: ./.pysstv/bin/python -m pysstv --mode PD290 --vox ../nextnextgen.png ../nextnextgen.wav
    return Promise.resolve();
}

let fixRate = async function (input, output){
    let cmd = "sox";
    let args = [input, "-r", "44100", output];
    console.log(cmd, args);
    let sp = await spawnProm(cmd, args);
    return Promise.resolve();
}


let opusify = async function (input, output){
    console.log("opusifying", input, output);
    let cmd = `ffmpeg -i ${input} -b:a 12k ${output}`;
    try { 
	let exec = cp.execSync(cmd);
	console.log(exec.toString());
    } catch(e){
        throw(e);
    }
    return Promise.resolve();

}

//inputs wav path, returns img path
let sstvDecode = async function (wav, output, other) {
    let scmd = "soxi " + wav;
    let getrate = cp.execSync(scmd).toString();
    let fields = getrate.split("\n")
    let line = fields.filter(line => line.includes("Sample Rate"));
    let sr = line[0].split(": ")[1];
    console.log(sr); //useful metadata?

    console.log(`converting ${wav} to ${output}`);
    let cmd = "/home/aphid/apps/slowrx-cli/slowrx-cli";
    let args = [wav, "-o", output];
    try {
    let sp = await spawnProm(cmd, args);
    if (!fs.existsSync(output)){
	await logRTTY("No SSTV signal detected in received audio, retrying...");
	console.log("NO SIGNAL IN WAV");
	fs.unlinkSync(wav);
	await ssh.connect();
	let delTask;
	try { 
        delTask = await ssh.exec(`rm ${wav} ${other}`);	
	} catch(e){
		//console.log(e);
		console.log("something wrong.");
		console.log(delTask);
	}
	console.log(delTask);
	ssh.close();
	//todo make this just re-doTheThing with the right gen. or just xmit and decode
	return Promise.resolve(false);
    }
    } catch(e) {
      throw(e);
    }
    return Promise.resolve(true);
    //command: ~/apps/slowrx-cli/slowrx-cli ./_oof.wav -o oof.bmp
}

//RTTY -- baudet (not full ascii/utf8) at like 45 baud.

//inputs text, returns path to wav;
let rttyEncode = async function (text, output, options) {
    console.log(`converting txt to ${output}`);
    if (text.split(".").pop() == "txt"){
        text = fs.readFileSync(text);
    }
    let cmd = "minimodem"
    let args = ["--write", "45.45", "--stopbits=1.5", "--ascii", "-f", output];

    let sp = await spawnProm(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }, text);
    //command: cat input_file.txt | minimodem --write rtty -f modem_audio.wav
    return Promise.resolve();
}

let rttyDecode = async function (opus, txt, options) {
    console.log("Decoding rtty opus");
    let output = opus.replace(".opus", ".txt");
    let cmd = "minimodem";
    let args = ["--rx", "45.45", "-q", "--file", opus];
    let sp = await spawnProm(cmd, args);
    console.log(sp);
    fs.writeFileSync(txt, sp);
    //command: minimodem --rx rtty -q --file modem_audio.wav > output_file.txt
}

//inputs image, outputs text/json
let getDescription = async function (image, options) {
    //command - some ollama shit? llama.cpp?
    //now in ollama.js
}


let iConvert = async function (infile, outfile, options) {
    let cmd = "convert";
    let args = [infile, outfile];
    let sp = await spawnProm(cmd, args);
    console.log(sp);
}

//inputs image, outputs image
let enhanceImage = async function (image, options) {

    let output = image.replace(".png", "_enhanced.png");
    let cmd = "/home/aphid/apps/realesrgan-ncnn-vulkan-20220424-ubuntu/realesrgan-ncnn-vulkan";
    let args = ["-i", image, "-o", output];
    let sp = await spawnProm(cmd, args);
    console.log(sp);
    //command ./realesrgan-ncnn-vulkan -i ~/liver.png -o liver.png


}

let leSox;
let leRtl;
let leIce;

let recordIce = async function (outfile){
   console.log("recording " + outfile);
   let cmd = "wget";
   let args = ["-O", outfile, "http://localhost:8000/enhance-redact.opus"];
   console.log(cmd, args);
   let rProcess = await cp.spawn(cmd, args);
   leIce = rProcess;
   let lastUpdate = Date.now();
   rProcess.stderr.on('data', (data) => {
       if (Date.now() - lastUpdate > 10000){
           console.log(`${data}`);
	   console.log(fs.statSync(outfile).size);
	   lastUpdate = Date.now();
	   
       }
   });
}

let record = async function (outfile, freq){
   if (!freq){
      freq = '91.3e6';
   }
   console.log("recording " + outfile);
   //rtl_fm -f 93.5e6 -M wbfm -E deemp -F 9 -| sox -t raw -e signed -c 1 -b 16 -r 32k - oof.wav
   let rtlCmd = "rtl_fm";
   let rtlArgs = ["-f", freq, '-M', 'wbfm', '-E', 'deemp', '-F', '9', '-'];
   console.log (rtlCmd, rtlArgs.join(" "));
   let rtlProcess = await cp.spawn(rtlCmd, rtlArgs);
   leRtl = rtlProcess;
   let soxCmd = "sox";
   let soxArgs = ["-t", "raw", "-e", "signed", "-c", "1", "-b", "16", "-r", "32k", "-", outfile]
   let soxProcess = await cp.spawn(soxCmd, soxArgs);
   rtlProcess.stdout.pipe(soxProcess.stdin);
   leSox = soxProcess;
   soxProcess.stderr.on('data', (data) => {
       console.error(`SoX stderr: ${data}`);
   });

  soxProcess.on('close', (code) => {
    if (code === 0) {
      console.log(`SoX process exited successfully. Output saved to ${outfile}`);
    } else {
      console.error(`SoX process exited with code ${code}`);
    }
    if (fs.statSync(outfile).size === 0){
	throw("rtlsdr connection might be broken");
    }
  });

}


let sstvComply = async function (image, output, options) {
    //let output = image.replace(".png", "_sstv-ready.png");
    let cmd = "convert";
    let args = [image, "-resize", "800x616", "-gravity", "center", "-background", "black", "-extent", "800x616", output];
    try { 
       let sp = await spawnProm(cmd, args);
       console.log(sp);
    } catch (e){
	throw(e);
    }
    //console.log(sp);
    return Promise.resolve();

}

let transceiveIce = async function(fn,wav){
   console.log("TRANSCIEVING");
   console.log(fn, wav);
   console.log("starting record...");
   recordIce(fn);
   await sleep(8000);
   console.log("xmitting...");
   //updateStatus({status: "transceiving", description: `(temporary) This SSTV signal encodes an image into distinct oscillating tones that switch back and forth, which are heard as a repetitive, warbling 'boo-boo-beeeeeeee-boo-boo-beeeeeeee' sound for the duration of the signal (four minutes and fifty seconds).`});
   updateStatus({status: "transceiving", description: `A background wash of broad smooth radio static containing moderately audible broadcast voices, punctuated by foregrounded patterned, repeating, and highly compressed digital signal tones indicating data transmission for nearly five minutes. Slight tonal or rhythmic variations accompany the beginning and end of the signal tone sequence.`, descriptionAuthor: `Anna Friz`});
   await xmit(wav);
   console.log("xmission over");
   await sleep(8000);
   console.log("ending record");
   leIce.kill();
}

let transceive = async function(fn,wav){
   console.log("TRANSCIEVING");
   console.log(fn, wav);
   console.log("starting record...");
   record(fn);
   await sleep(5000);
   console.log("xmitting...");
   await xmit(wav);
   console.log("xmission over");
   await sleep(5000);
   console.log("ending record");
   leSox.kill();
   leRtl.kill();
}

//await sttvEncode("liver.png");
//await sttvDecode("liver.wav");
//await rttyEncode(`[ "facé", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "face", "bee", "beetle", "wire", "machine"]`);
//await rttyDecode("sampletext.wav");
//await enhanceImage("nnnng.png");
//await sstvComply("liver.png");
//await iConvert("liver.png", "liver__.bmp");

//await transcieve();

async function json2words(json,txt){
   console.log("json to words: ", json);
   let data = JSON.parse(fs.readFileSync(json));
   let words = data.items;
   if (words && words.length){
       fs.writeFileSync(txt, words.join(", "));
   }
   return Promise.resolve();
}

async function cleanUp(gen, fn, syncs){
   console.log("syncing", syncs, "for", fn);
   let clean = [
	   `images/${fn}_sstv.png`, //should match rx of prev gen
           `sounds/${fn}_sstv.wav`,
	   `sounds/${fn}_rx.wav`,
           `images/${fn}_rx.bmp`,
	   `images/${fn}_rx.png`,
	   `images/${fn}_enh.png`,
           `sounds/${fn}_rtty.wav`,
	   `sounds/${fn}_rx.mp3`,
	   `sounds/${fn}_rtty.mp3`,
	   `text/${fn}_rx.txt`
   ];
  for (let f of fs.readdirSync("logrtty")){
      clean.push("logrtty/" + f);
  }
  for (let c of clean){
      console.log("cleaning up", c);
      try { 
      if (fs.existsSync(c)){
         fs.unlinkSync(c);
	 await ssh.exec(`rm ${c}`);
      }
      } catch (e){
         //console.error(e);
      }
      ssh.close();
  }
  findings(syncs, fn); 

  return Promise.resolve();

}

let currentScan, lastImg;

async function findings(syncs, fn){
   console.log(syncs, fn);
   let sshconfig = {
	host: 'aphid.org',
	username: 'aphid',
	identity: '/home/aphid/.ssh/id_ed25519',
	reconnectTries: 10,
	reconnectDelay: 5000
   };
   const ssh = new SSH2Promise(sshconfig);
   var sftp = new SSH2Promise.SFTP(ssh);
 
   try {
       console.log("syncing with webserver");
       await ssh.connect();
   } catch(e){
       console.error("something went wrong syncing with web server", e);
       logRTTY("server unresponsive, attempting to reconnect");
       await sleep(15000);
       return await findings(syncs);
   }
   let remote = "/mnt/HC_Volume_104554153/css/";
   for (let u of syncs){
      let rem = remote;
      console.log("u: ", u);
      let t;
      console.log("uploading", u, "to", remote+u);
      if (u.includes("avif")){
	 t = u.replace("findings", "images");
      } else if (u.includes("opus")){
         t = u.replace("findings", "sounds");
      } else if (u.includes("txt")){
         t = u.replace("findings","text");
      }
      console.log("rem: ", rem);
      console.log(u, "to", rem+u)
      await sftp.fastPut(u, rem+t, {});
      console.log("done", u, rem+t);
   }
   try { 
   await ssh.close();
   await sftp.close();
   } catch(e){
     console.log("ssh/sftp closing", e);
   }
   lastImg = syncs[1];
   return Promise.resolve();
}

let updateLog = async function(json){
    let log = fs.readFileSync("statuslog.json");
    let items = JSON.parse(log);
    items.push(json);
    fs.writeFileSync("statuslog.json", JSON.stringify(items, undefined, 2));
    return Promise.resolve();
}

let updateStatus = async function(json){
    console.log(json);
    json.timestamp = Date.now();
    if (currentScan){
        json.currentScan = currentScan;
    }
    if (lastImg){
        json.lastImage = lastImg;
    }
    await updateLog(json);
    json.passkey = auth.statuspass;
    console.log(json);
    const url = "https://station.aphid.org/current_metadata/";
    const options = {
        method: "POST",
	body: JSON.stringify(json),
	headers: {
	    "Content-Type": "application/json"
	}
    };
    try { 
        let f = await fetch(url, options);
        f = await f.json();
        console.log("Response: ", f);
    } catch(e){
        console.error("Status Update Error:", url, json, e);
    }
    
};


let files = fs.readdirSync("sources/").filter((file) => (file.includes(".jpg") ||  file.includes(".png")));

async function doTheThing(gen, fun){
   updateStatus({status: "working", description: "soft radio static"});
   console.log("starting cycle");
   await sync();
   let target;
   let source;
   let genStr;
   console.log("checking current gen");
   if (!gen || gen >= 46){ 
       console.log("new file");
       await beachbell();
       target = files.pop();
       source = `sources/${target}`;
       gen = 0;
       genStr = (gen + "").padStart(2,"0");
   } else {
       console.log("existing file", fun);
       genStr = (gen + "").padStart(2,"0");
       let pGenStr = ((gen - 1) + "").padStart(2,"0");
       let files = fs.readdirSync("findings/").filter(file => (file.includes(fun) && file.includes(`gen-${pGenStr}_enh`) && file.includes(".avif")));
       console.log("files: ", files);
       target = files[0];
       source = `findings/${target}`;
   }
   //console.log(gen, genStr);
   //console.log(target, source)
   //let fn = target.split(".")[0] + ".gen-" + genStr;
   let fn;
   console.log(target);
   if (target){
       fn = target.split(".")[0] + ".gen-" + genStr;
   } else {
       fn = fun + ".gen-" + genStr;
   }
   console.log(fn);
   currentScan = fn;
   if (!currentScan){
       throw("scanname is broken");
   }
   let lastt = "findings/" + fn.split(".")[0] + ".gen-45_rx.opus";
   console.log("checking existance of gen 45", lastt);
   //if txt exists for last gen...
   if (fs.existsSync(lastt)){
       console.log("this file is complete");
       //await beachbell();
       return await doTheThing();
   }
   console.log(fn);
   let sstvI = `images/${fn}_sstv.png`;
   let sstvW = `sounds/${fn}_sstv.wav`;
   let sstvRm = `sounds/${fn}_rx.opus`;
   let opus = `findings/${fn}_rx.opus`;
   let sstvRw = `sounds/${fn}_rx.wav`;
   let sstvIR = `images/${fn}_rx.bmp`;
   let sstvIRp = `images/${fn}_rx.png`;	
   let avif = `findings/${fn}_rx.avif`;
   let avife = `findings/${fn}_enh.avif`;
   let enh = `images/${fn}_enh.png`;
   let data = `data/${fn}.json`;
   let words = `text/${fn}.txt`;
   let rtty = `sounds/${fn}_rtty.wav`;
   let rttyrx = `sounds/${fn}_rtty_rx.opus`;
   let rttyfind = `findings/${fn}_rtty_rx.opus`;
   let txtrx = `text/${fn}_rx.txt`;
   let txtfind = `findings/${fn}_rx.txt`;
   let syncs = [opus, avif, avife, rttyfind, txtfind].filter((e) => !e.includes(".gen-00_") && !e.includes("portrait"));

   console.log(source, sstvI);

   if (fs.existsSync(txtfind)){
       console.log("gen complete");
       await logRTTY(`${fn} complete`);
       console.log("ding ding ding");
       await radbell();
       await cleanUp(gen, fn, syncs);
       return await doTheThing(gen+1, fn);
   }
   if (!fs.existsSync(sstvI)){
       console.log("converting", source, sstvI);
       await sstvComply(source, sstvI);
       await sync();
   }

   let success = false;
   while (!success){
       console.log("Checking for raw sstv sound");
       if (!fs.existsSync(sstvW)){
           await sstvEncode(sstvI);
           await sync();
       }

       if (fs.existsSync(sstvIR)){
         success = true;
         await iConvert(sstvIR, sstvIRp);
	 await sync();
       }
       console.log("Checking for rx'd sstv sound");
       if (!fs.existsSync(sstvRw) || (!fs.existsSync(sstvRm))){
           let msg = `${sstvI} as sstv`;
           await logRTTY(msg);
           changeTitle(msg);
           await transceiveIce(sstvRm,sstvW);
           console.log("fixing rate");
           await fixRate(sstvRm, sstvRw);
           await sync();
       }
       console.log("Checking for rx'd sstv image");
       if (!fs.existsSync(sstvIR)){
           if (!fs.existsSync(sstvRw)){
              throw("missing", sstvRw);
	   }
           let test = await sstvDecode(sstvRw, sstvIR, sstvW);
	   if (test){
               success = true;
               await iConvert(sstvIR, sstvIRp);
               await sync();
	   }
           else {
	       await sync();
	   }
       }
   }
   console.log("Checking for enhanced image");
   if (!fs.existsSync(enh)){
       let msg = `enhancing_${sstvIRp}`;
       await logRTTY(msg);
       changeTitle(msg);
       await enhance(sstvIRp,enh);
       await sync();
   }
   console.log("Checking for data from image");
   if (!fs.existsSync(data)){
       let msg = `finding objects in ${enh}`;
       await logRTTY(msg);
       changeTitle(msg);
       await llamatime(enh, fn);
       await sync();
   }
   console.log("Checking for text from image data");
   if (!fs.existsSync(words)){
       await json2words(data,words);
       await sync();
   }
   console.log("checking for wav from image data text");
   if (!fs.existsSync(rtty)){
       await rttyEncode(words,rtty);
       await sync();
   }
   console.log("checking for rx'd wav from image data text");
   if (!fs.existsSync(rttyrx)){
       let msg = `${words} as rtty`;
       //await logRTTY(msg);
       //await sleep(12000);
       changeTitle(msg);
       await transceiveIce(rttyrx, rtty);
       await sync();
   }
   if (fs.existsSync(rttyrx) && !fs.existsSync(rttyfind)){
       console.log("copying", rttyrx, rttyfind);
       fs.copyFileSync(rttyrx, rttyfind);
   }
   console.log("checking for rx'd text from image data text wav");
   if (!fs.existsSync(txtrx)){
       await rttyDecode(rttyrx, txtrx);
       await sync();
   }
   console.log("checking for findings text");
   if (!fs.existsSync(txtfind)){
       fs.copyFileSync(txtrx,txtfind)
   }
   console.log("checking for reg avif");
   if (!fs.existsSync(avif)){
       await iConvert(sstvIRp, avif);
   }
   console.log("checking for enh avif");
   if (!fs.existsSync(avife)){
       await iConvert(enh, avife);
   }
   console.log("checking for findings opus");
   if (!fs.existsSync(opus)){
       await opusify(sstvRw,opus);
   }
   console.log("end of gen");
   await logRTTY("end of process for this generation");
   await radbell();
   await cleanUp(gen, fn, syncs);
   await doTheThing(gen+1, fn);
  
}


//ffs move these to json or something
let prompt = `This image might appear abstract or glitched, but it is not. It has been enhanced to expose figments and monsters that were previously smaller than a pixel. You should be able to identify at least 23 distinct things in the image which are not merely abstract shapes. Tell me *specifically*  what they are (an artwork or illustration does not suffice as an answer), even if you have to guess. "Abstract shape" or "unidentifiable object" are not a valid answers; If you aren't sure, then use your imagination to fill in the parts you mannot make sense of. For the purposes of your count (not for JSON presentaiton), a collection of similar things should only count as one item. Your responses should be in the form of *VALID* JSON, the narrative response as a property of 'description' in a single string and the second list, as property 'items', should be an array of strings. First describe what you think you see, then provide a second list in of the same items as an array of nouns (no adjectives, parentheticals, or qualifications) as though you were fully certain of what they are.`;

let moondream = `This image has been enhanced to expose figments and monsters that were previously smaller than a pixel. Make a list at least 12 of the objects, figments, or monsters you identify in the image, even if you have to use your imagination. Then output your findings as a JSON array of short descriptive strings.`;



let models = [
  "gemma3",
  "llava",
  "ALIENTELLIGENCE/medicalimaginganalysis",
  //"moondream"
];

let model = "";

function getRandomElement(arr) {

  // Generate a random number between 0 (inclusive) and 1 (exclusive)
  const randomIndex = Math.floor(Math.random() * arr.length);

  // Return the element at the randomly generated index
  return arr[randomIndex];
}

async function runQuery(img) {
  model = getRandomElement(models);
  let content;
  if (model == "moondream"){
    content = moondream;
  } else {
    content = prompt;
  }
  img =  base64_encode(img);

  console.log("Running vision with", model);
  await logRTTY("analyzing image with " + model);
  let response;
  try { 
    response = await ollama.chat({
    model: model,
    messages: [{
      role: 'user', content: content, images: [img]
    }]
  });
  } catch(e) {
    console.error("ollama failed", e);
    return Promise.resolve(false);	  
  }
  //console.log(response.message.content)
  console.log(response);
  if (response && response.message && response.message.content){
      let resp = response.message.content;
      console.log(resp);
      console.log("Extracting JSON");
      let json = extractObject(resp);
      console.log(json);
      breathing = false;
      return Promise.resolve({data: json, model: model});
  } else {
      return Promise.resolve(false);
  }
}

function extractObject(str) {
  console.log("trying object");
  const startIndex = str.indexOf("{");
  const endIndex = str.lastIndexOf("}") + 1; // +1 to include the closing brace
  const jsonString = str.substring(startIndex, endIndex);
  console.log(jsonString);
  if (isJson(jsonString)){
    console.log("YES");
    let result = jsonString;
    return JSON.parse(result);
  } else {
    return extractArray(str);
  }
}

function isJson(str) {
  try {
    JSON.parse(str);
  } catch (e) {
    return false;
  }
  return true;
}

function extractArray(str, last) {
  console.log("trying array");
  const startIndex = str.indexOf("[");
  const endIndex = str.lastIndexOf("]") + 1; // +1 to include the closing brace
  const jsonString = str.substring(startIndex, endIndex);
  console.log(jsonString);
  if (isJson(jsonString)) {
    console.log("YES");
    return { items: JSON.parse(jsonString)};
  } else {
    if (!last) {
      console.log("replacing");
      return extractArray(str.replaceAll("'", '"'), true);
    }
  }

}

let breathTimer;

async function llamatime(img, fn) {
  breathing = true;
  breathTimer = Date.now();
  let bs = breathCycle(img);
  let rq = runQuery(img);
  console.log("llamatime");
  let [answer, b] = await Promise.all([rq, bs]);
  if (!answer){
      breathing = false;
      console.error("no answer from ollama");
      return await llamatime(img,fn);
  }
  console.log("------------------------------------------");
  let data;
  try {
    data = answer.data;
    data.model = answer.model;
    if (!data.items || !data.items.length){
	console.error("no items found in response");
        return await llamatime(img, fn);
    }
    //delete data.description;
  } catch (e) {
    ollama.abort();
    breathing = false;
    console.log(e);
    await logRTTY("recognition JSON didn't parse, retrying")
    console.log("didn't parse, trying again");
    
    return await llamatime(img, fn);
  }
  ollama.abort();
  console.log(data);
  fs.writeFileSync("data/" + fn + ".json", JSON.stringify(data));
  return Promise.resolve();
}







doTheThing();


