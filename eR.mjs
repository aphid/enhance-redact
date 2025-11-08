//some includes
import * as fs from 'fs';
import * as cp from 'child_process';
import { exiftool } from "exiftool-vendored";
import anyAscii from 'any-ascii';
import ollama from 'ollama';
import SSH2Promise from 'ssh2-promise';
import Rsync from "@moritzloewenstein/rsync";
import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
  new Agent({
    headersTimeout: 600000,
    connectTimeout: 600000,
    bodyTimeout: 600000,
  }),
);



let dirs = ["sources/", "images/", "sounds/", "text/", "data/"];

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

function base64_encode(file) {
  // read binary data
  var bitmap = fs.readFileSync(file);
  // convert binary data to base64 encoded string
  return Buffer.from(bitmap).toString('base64');
}


async function sync(){

   for (let d of dirs){

    const rsync = new Rsync({
       source: `${d}`,
       destination: `slowscan.local:~/${d}`,
       flags: "avz",
       shell: "ssh",
    });

   try {
      const result = await rsync.execute();
      console.log("Transfer complete:", result.cmd);
   } catch (error) {
      console.error("Transfer failed:", error);
   }
}

for (let d of dirs){

   const rsync = new Rsync({
      source: `slowscan.local:~/${d}`,
      destination: `${d}`,
      flags: "avz",
      shell: "ssh",
   });
   
   try {
      const result = await rsync.execute();
      console.log("Transfer complete:", result.cmd);
   } catch (error) {
      console.error("Transfer failed:", error);
   }



}
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
                console.log(data);
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
    await sleep(250);
    let command = await ssh.exec(`sudo ./fm_transmitter/fm_transmitter -f 93.500 ${fn}`);
    console.log(command);
    ssh.close();
    return Promise.resolve();
}

let enhance = async function(inn,out){
    return new Promise(async(resolve, reject) => {
    console.log(new Date());
    console.log("spawning...");
    let command = await ssh.spawn(`Real-ESRGAN-ncnn-vulkan/realesrgan-ncnn-vulkan -i ${inn} -o ${out}`); //-n realesrgan-x4plus? currently fails with 'killed' 
    command.stderr.on('data', (data) => {
       let dataString = data.toString();
       console.log(dataString);
    });
    command.on('exit', () => {
    console.log(new Date());
    ssh.close();
    resolve();
    });
    command.on('close', () => {
    console.log(new Date());
    ssh.close();
    resolve();
    });
    command.on('error', (e) => {
       console.log(e);
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

let fixRate = async function (wav){
    let cmd = "sox";
    let targ = wav.replace("_rx", "rx_44100");
    let args = [wav, "-r", "44100", targ];
    let sp = await spawnProm(cmd, args);
    fs.renameSync(targ, wav);
    return Promise.resolve();
}

//inputs wav path, returns img path
let sstvDecode = async function (wav, output, options) {
    const sr = (await exiftool.read(wav)).SampleRate;
    console.log(sr);

    console.log(`converting ${wav} to ${output}`);
    let cmd = "/home/aphid/apps/slowrx-cli/slowrx-cli";
    let args = [wav, "-o", output];
    try {
    let sp = await spawnProm(cmd, args);
    if (!fs.existsSync(output)){
	console.log("NO SIGNAL IN WAV");
	fs.unlinkSync(wav);
        let delTask = await ssh.exec(`rm ${wav}`);	
	console.log(delTask);
    	process.exit();
    }
    } catch(e) {
      throw(e);
    }
    return Promise.resolve();
    //command: ~/apps/slowrx-cli/slowrx-cli ./_oof.wav -o oof.bmp
}

//RTTY -- baudet (not full ascii/utf8) at like 45 baud.

//inputs text, returns path to wav;
let rttyEncode = async function (text, output, options) {
    console.log(`converting txt to ${output}`);
    text = fs.readFileSync(text);
    let cmd = "minimodem"
    let args = ["--write", "45.45", "--stopbits=1.5", "--ascii", "-f", output];

    let sp = await spawnProm(cmd, args, { stdio: ["pipe", "pipe", "pipe"] }, text);
    //command: cat input_file.txt | minimodem --write rtty -f modem_audio.wav
    return Promise.resolve();
}

let rttyDecode = async function (wav, options) {
    let output = wav.replace(".wav", ".txt");
    let cmd = "minimodem";
    let args = ["--rx", "45.45", "-q", "--file", wav];
    let sp = await spawnProm(cmd, args);
    console.log(sp);
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

let record = async function (outfile, freq){
   if (!freq){
      freq = '93.5e6';
   }
   console.log("recording " + outfile);
   //rtl_fm -f 93.5e6 -M wbfm -E deemp -F 9 -| sox -t raw -e signed -c 1 -b 16 -r 32k - oof.wav
   let rtlCmd = "rtl_fm";
   let rtlArgs = ["-f", freq, '-M', 'wbfm', '-E', 'deemp', '-F', '9', '-'];
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
   let data = JSON.parse(fs.readFileSync(json));
   let words = data.items;
   fs.writeFileSync(txt, words.join(", "));
  
}

async function doTheThing(gen, fun){
   await sync();
   let target;
   let source;
   if (!gen){ 
       let files = fs.readdirSync("sources/").filter((file) => (file.includes(".jpg") || file.includes(".png")));
       console.log(files);
       target = files.shift();
       source = `sources/${target}`;
       gen = 0;
   } else {
       let files = fs.readdirSync("images/").filter((file => (file.includes(fun) && file.includes(`gen-${gen - 1}_enh`) && file.includes(".png"))));
       console.log(files);
       target = files[0];
       source = `images/${target}`;
   }

   let fn = target.split(".")[0] + ".gen-" + gen;
   console.log(fn);
   let sstvI = `images/${fn}_sstv.png`;
   let sstvW = `sounds/${fn}_sstv.wav`;
   let sstvR = `sounds/${fn}_rx.wav`;
   let sstvIR = `images/${fn}_rx.bmp`;
   let sstvIRp = `images/${fn}_rx.png`;	
   let enh = `images/${fn}_enh.png`;
   let data = `data/${fn}.json`;
   let words = `text/${fn}.txt`;
   let rtty = `sounds/${fn}_rtty.wav`;
   let rttyrx = `sounds/${fn}_rtty_rx.wav`;
   let txtrx = `text/${fn}_rx.txt`;
   console.log(source, sstvI);
   if (!fs.existsSync(sstvI)){
       await sstvComply(source, sstvI);
       await sync();
   }
   if (!fs.existsSync(sstvW)){
       await sstvEncode(sstvI);
       await sync();
   }
   if (!fs.existsSync(sstvR)){
       await transceive(sstvR,sstvW);
       console.log("fixing rate");
       await fixRate(sstvR);
       await sync();
   }
   if (!fs.existsSync(sstvIR)){
       await sstvDecode(sstvR, sstvIR);
       await iConvert(sstvIR, sstvIRp);
       await sync();
   }
   if (!fs.existsSync(enh)){
       await enhance(sstvIRp,enh);
       await sync();
   }
   if (!fs.existsSync(data)){
       await llamatime(enh, fn);
       await sync();
   }
   if (!fs.existsSync(words)){
       await json2words(data,words);
       await sync();
   }
   if (!fs.existsSync(rtty)){
       await rttyEncode(words,rtty);
       await sync();
   }
   if (!fs.existsSync(rttyrx)){
       await transceive(rttyrx, rtty);
       await sync();
   }
   if (!fs.existsSync(txtrx)){
       console.log("idk how to do this yet");
   }
   console.log("end of gen");
   doTheThing(gen+1, fn);
}


//ffs move these to json or something
let prompt = `This image might appear abstract or glitched, but it is not. It has been enhanced to expose figments and monsters that were previously smaller than a pixel. You should be able to identify at least 23 distinct things in the image which are not merely abstract shapes. Tell me *specifically*  what they are (an artwork or illustration does not suffice as an answer), even if you have to guess. "Abstract shape" or "unidentifiable object" are not a valid answers; If you aren't sure, then use your imagination to fill in the parts you cannot make sense of. For the purposes of your count (not for JSON presentaiton), a collection of similar things should only count as one item. Your responses should be in the form of *VALID* JSON, the narrative response as a property of 'description' in a single string and the second list, as property 'items', should be an array of strings. First describe what you think you see, then provide a second list in of the same items as an array of nouns (no adjectives, parentheticals, or qualifications) as though you were fully certain of what they are.`;

let moondream = `This image has been enhanced to expose figments and monsters that were previously smaller than a pixel. Make a list at least 12 of the objects, figments, or monsters you identify in the image, even if you have to use your imagination. Then output your findings as a JSON array of short descriptive strings.`;



let models = [
  "gemma3",
  "llava",
  "ALIENTELLIGENCE/medicalimaginganalysis",
  "moondream"
]

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
  const response = await ollama.chat({
    model: model,
    messages: [{
      role: 'user', content: content, images: [img]
    }]
  });
  //console.log(response.message.content)
  let resp = response.message.content;
  console.log(resp);
  console.log("Extracting JSON");
  let json = extractObject(resp);
  console.log(json);
  return json;
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

async function llamatime(img, fn) {
  let answer = await runQuery(img);
  console.log("------------------------------------------");
  let data;
  try {
    data = answer;
    data.model = model;
    
    //delete data.description;
  } catch (e) {
    ollama.abort();
    console.log(e);
    console.log("didn't parse, trying again")
    return llamatime(img, fn);
  }
  ollama.abort();
  console.log(data);
  fs.writeFileSync("data/" + fn + ".json", JSON.stringify(data));
  return Promise.resolve();
}







doTheThing();


